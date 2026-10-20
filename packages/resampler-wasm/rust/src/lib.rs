// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A rubato sinc resampler behind a tiny C ABI, for wasm32-unknown-unknown.
//
// No wasm-bindgen: the JS side talks to these `extern "C"` functions through
// `WebAssembly.Instance.exports` and reads/writes PCM directly in linear memory.
//
// Model: every resampler is a *stream* (one-shot resampling is "process the
// whole clip, then flush"). A stream owns its staging buffers:
//
//   ptr = rs_stream_input(h, n)      // room for n int16 samples (interleaved)
//   ... JS copies n samples to ptr ...
//   m = rs_stream_process(h, n)      // m int16 samples are now at rs_stream_output(h)
//   m = rs_stream_flush(h)           // drain the filter tail, then reset
//
// The `_f32` variants do the same with float samples in [-1, 1] (unclipped).
//
// Streams accept any number of samples per call. rubato's `Async` resampler
// processes fixed-size input chunks, so a call is split into pieces of at most
// MAX_CHUNK frames and the chunk size is set to each piece's length
// (`Resizable::set_chunk_size` keeps the filter history), which means no
// input is held back beyond the filter's own delay. A sample count that is
// not a multiple of the channel count leaves the remainder buffered for the
// next call.
//
// Output is aligned with the input: the filter's start-up delay is trimmed
// from the front of the stream, and `flush` emits exactly
// round(total_input_frames * out_rate / in_rate) frames in total, like
// libsoxr's `ResampleStream` with `last=True`.

use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{
    Async, FixedAsync, Indexing, Resampler, Resizable, SincInterpolationParameters,
    SincInterpolationType, WindowFunction,
};

/// Largest input chunk handed to rubato in one go, in frames.
const MAX_CHUNK: usize = 1024;

/// Quality presets, in the same order as libsoxr's (QQ=0 .. VHQ=4).
#[derive(Clone, Copy)]
pub struct Preset {
    pub sinc_len: usize,
    pub oversampling: usize,
    pub window: WindowFunction,
    pub interpolation: SincInterpolationType,
}

/// The anti-aliasing cutoff is left automatic (`f_cutoff: None`): rubato's
/// `calculate_cutoff` picks the highest cutoff that keeps aliasing below the
/// window's sidelobe level for that filter length, so it rises with sinc_len.
pub fn preset(quality: u32) -> Option<Preset> {
    use SincInterpolationType::*;
    use WindowFunction::*;
    let p = |sinc_len, oversampling, window, interpolation| Preset {
        sinc_len,
        oversampling,
        window,
        interpolation,
    };
    Some(match quality {
        0 => p(16, 32, Hann2, Linear),            // QQ
        1 => p(32, 64, Blackman2, Linear),        // LQ
        2 => p(64, 128, Blackman2, Quadratic),    // MQ
        3 => p(128, 256, BlackmanHarris2, Cubic), // HQ
        4 => p(256, 256, BlackmanHarris2, Cubic), // VHQ
        _ => return None,
    })
}

pub struct Stream {
    resampler: Async<f32>,
    channels: usize,
    ratio: f64,
    cutoff: f32,
    /// Output frames to drop at the start of every stream (filter delay).
    delay: usize,
    /// Zero frames fed before the first input so that `delay` is a whole
    /// number of output frames (see `alignment`).
    prime: usize,
    /// Whether the priming zeros still have to be fed.
    needs_prime: bool,
    /// Output frames still to drop at the start of this stream.
    delay_left: usize,
    /// Input frames consumed since the stream started (or was last reset).
    total_in: u64,
    /// Output frames emitted since the stream started (or was last reset).
    total_out: u64,
    /// Samples (< channels) left over from the previous call.
    carry: Vec<f32>,
    /// Staging areas JS writes input into.
    input_i16: Vec<i16>,
    input_f32: Vec<f32>,
    /// Interleaved float input (carry + input).
    in_f: Vec<f32>,
    /// One rubato output chunk.
    out_f: Vec<f32>,
    /// The result of the last process/flush call.
    res: Vec<f32>,
    output_i16: Vec<i16>,
}

impl Stream {
    pub fn new(in_rate: u32, out_rate: u32, channels: u32, quality: u32) -> Option<Stream> {
        if in_rate == 0 || out_rate == 0 || channels == 0 || channels > 8 {
            return None;
        }
        let p = preset(quality)?;
        let ratio = out_rate as f64 / in_rate as f64;
        let params = SincInterpolationParameters::new(p.sinc_len, p.window)
            .oversampling_factor(p.oversampling)
            .interpolation(p.interpolation);
        let resampler = Async::<f32>::new_sinc(
            ratio,
            1.0,
            &params,
            MAX_CHUNK,
            channels as usize,
            FixedAsync::Input,
        )
        .ok()?;
        let cutoff = resampler.cutoff().unwrap_or(0.0);
        let out_cap = resampler.output_frames_max() * channels as usize;
        let (prime, delay) = alignment(in_rate, out_rate, p.sinc_len);
        Some(Stream {
            resampler,
            channels: channels as usize,
            ratio,
            cutoff,
            delay,
            prime,
            needs_prime: true,
            delay_left: delay,
            total_in: 0,
            total_out: 0,
            carry: Vec::new(),
            input_i16: Vec::new(),
            input_f32: Vec::new(),
            in_f: Vec::new(),
            out_f: vec![0.0; out_cap],
            res: Vec::new(),
            output_i16: Vec::new(),
        })
    }

    pub fn reset(&mut self) {
        self.resampler.reset();
        self.needs_prime = true;
        self.delay_left = self.delay;
        self.total_in = 0;
        self.total_out = 0;
        self.carry.clear();
    }

    /// Run one rubato chunk of `frames` input frames starting at frame
    /// `offset` of `in_f` (`silence` feeds a full chunk of zeros instead), and
    /// append the delay-trimmed result to `res`.
    fn run_chunk(&mut self, offset: usize, frames: usize, silence: bool) -> bool {
        let ch = self.channels;
        let chunk = if silence { MAX_CHUNK } else { frames };
        if self.resampler.set_chunk_size(chunk).is_err() {
            return false;
        }
        let (src, src_frames, indexing) = if silence {
            (&[][..], 0, Indexing::new().partial_len(0))
        } else {
            (
                &self.in_f[..],
                self.in_f.len() / ch,
                Indexing::new().input_offset(offset),
            )
        };
        let Ok(input) = InterleavedSlice::new(src, ch, src_frames) else {
            return false;
        };
        let out_frames = self.out_f.len() / ch;
        let Ok(mut output) = InterleavedSlice::new_mut(&mut self.out_f, ch, out_frames) else {
            return false;
        };
        let Ok((_, produced)) =
            self.resampler
                .process_into_buffer(&input, &mut output, Some(&indexing))
        else {
            return false;
        };
        let skip = self.delay_left.min(produced);
        self.delay_left -= skip;
        self.total_out += (produced - skip) as u64;
        self.res
            .extend_from_slice(&self.out_f[skip * ch..produced * ch]);
        true
    }

    /// Resample `samples` (interleaved, float). The result is left in `res`.
    fn process(&mut self, samples: impl Iterator<Item = f32>) -> bool {
        let ch = self.channels;
        self.res.clear();
        self.in_f.clear();
        if self.needs_prime {
            self.needs_prime = false;
            self.in_f.resize(self.prime * ch, 0.0);
        }
        let primed = self.in_f.len() / ch;
        self.in_f.extend_from_slice(&self.carry);
        self.in_f.extend(samples);
        let frames = self.in_f.len() / ch;
        self.carry.clear();
        self.carry.extend_from_slice(&self.in_f[frames * ch..]);
        self.in_f.truncate(frames * ch);
        self.total_in += (frames - primed) as u64;

        let mut offset = 0;
        while offset < frames {
            let piece = (frames - offset).min(MAX_CHUNK);
            if !self.run_chunk(offset, piece, false) {
                return false;
            }
            offset += piece;
        }
        true
    }

    /// Emit the audio held in the filter, then reset. The result is left in `res`.
    fn flush(&mut self) -> bool {
        let ch = self.channels;
        self.res.clear();
        let expected = (self.total_in as f64 * self.ratio).round() as u64;
        // A few silent chunks always cover the filter delay; bound the loop anyway.
        let mut guard = 64;
        while self.total_out < expected && guard > 0 {
            if !self.run_chunk(0, 0, true) {
                return false;
            }
            guard -= 1;
        }
        if self.total_out > expected {
            let extra = (self.total_out - expected) as usize;
            let keep = self.res.len().saturating_sub(extra * ch);
            self.res.truncate(keep);
        }
        self.reset();
        true
    }

    fn result_i16(&mut self, ok: bool) -> i32 {
        self.output_i16.clear();
        if !ok {
            return -1;
        }
        self.output_i16.extend(self.res.iter().map(|&v| to_i16(v)));
        self.output_i16.len() as i32
    }

    fn result_f32(&self, ok: bool) -> i32 {
        if ok {
            self.res.len() as i32
        } else {
            -1
        }
    }
}

/// Choose how many zero frames to prime a stream with, and how many output
/// frames to trim, so the output is sample-aligned with the input.
///
/// rubato's first output frame sits at input position `1/ratio - sinc_len/2`,
/// i.e. the stream is delayed by `D = sinc_len*ratio/2 - 1` output frames.
/// `D` is fractional for many ratios (e.g. 48k->16k), and a fractional delay
/// cannot be trimmed. Priming with `k` zero input frames adds `k*ratio`
/// output frames of delay; with ratio = p/q in lowest terms some k < 2q makes
/// the total a whole number. Returns `(k, round(total delay))`.
fn alignment(in_rate: u32, out_rate: u32, sinc_len: usize) -> (usize, usize) {
    let g = gcd(in_rate as u64, out_rate as u64);
    let (p, q) = ((out_rate as u64 / g) as i128, (in_rate as u64 / g) as i128);
    let l = sinc_len.div_ceil(8) as i128 * 8;
    // total(k) = (l*p + 2*k*p - 2*q) / (2*q) output frames.
    let den = 2 * q;
    let mut best = (0i128, i128::MAX);
    for k in 0..den.min(1 << 16) {
        let num = l * p + 2 * k * p - 2 * q;
        let rem = num.rem_euclid(den).min(den - num.rem_euclid(den));
        if rem < best.1 {
            best = (k, rem);
            if rem == 0 {
                break;
            }
        }
    }
    let k = best.0;
    let num = l * p + 2 * k * p - 2 * q;
    let delay = ((num as f64) / (den as f64)).round().max(0.0) as usize;
    (k as usize, delay)
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a.max(1)
}

#[inline]
fn to_i16(v: f32) -> i16 {
    let s = (v * 32768.0).round();
    if s >= 32767.0 {
        32767
    } else if s <= -32768.0 {
        -32768
    } else {
        s as i16
    }
}

// ---------------------------------------------------------------------------
// C ABI
// ---------------------------------------------------------------------------

/// Allocate `len` bytes (8-byte aligned) in linear memory.
#[no_mangle]
pub extern "C" fn rs_alloc(len: usize) -> *mut u8 {
    let words = len.div_ceil(8).max(1);
    let mut v: Vec<u64> = Vec::with_capacity(words);
    let ptr = v.as_mut_ptr() as *mut u8;
    core::mem::forget(v);
    ptr
}

/// Free a block returned by `rs_alloc(len)`.
///
/// # Safety
/// `ptr` must come from `rs_alloc` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn rs_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let words = len.div_ceil(8).max(1);
    drop(Vec::from_raw_parts(ptr as *mut u64, 0, words));
}

/// Create a stream. `quality`: 0=QQ, 1=LQ, 2=MQ, 3=HQ, 4=VHQ. Returns 0 on
/// invalid parameters (zero rate, channels outside 1..=8, unknown quality).
#[no_mangle]
pub extern "C" fn rs_stream_new(
    in_rate: u32,
    out_rate: u32,
    channels: u32,
    quality: u32,
) -> *mut Stream {
    match Stream::new(in_rate, out_rate, channels, quality) {
        Some(s) => Box::into_raw(Box::new(s)),
        None => core::ptr::null_mut(),
    }
}

/// # Safety
/// `h` must be a live handle from `rs_stream_new`; it is invalid afterwards.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_free(h: *mut Stream) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

/// Make room for `n` int16 input samples and return where to write them.
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_input(h: *mut Stream, n: usize) -> *mut i16 {
    let s = &mut *h;
    s.input_i16.resize(n, 0);
    s.input_i16.as_mut_ptr()
}

/// Resample the `n` int16 samples written at `rs_stream_input`. Returns the
/// number of int16 samples now at `rs_stream_output`, or -1 on error.
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_process(h: *mut Stream, n: usize) -> i32 {
    let s = &mut *h;
    let input = core::mem::take(&mut s.input_i16);
    let n = n.min(input.len());
    let ok = s.process(input[..n].iter().map(|&v| v as f32 / 32768.0));
    s.input_i16 = input;
    s.result_i16(ok)
}

/// Drain the filter tail and reset. Returns the number of int16 samples now
/// at `rs_stream_output`, or -1 on error.
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_flush(h: *mut Stream) -> i32 {
    let s = &mut *h;
    let ok = s.flush();
    s.result_i16(ok)
}

/// Pointer to the int16 output of the last `rs_stream_process`/`rs_stream_flush`.
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_output(h: *mut Stream) -> *const i16 {
    (*h).output_i16.as_ptr()
}

/// Make room for `n` float input samples and return where to write them.
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_input_f32(h: *mut Stream, n: usize) -> *mut f32 {
    let s = &mut *h;
    s.input_f32.resize(n, 0.0);
    s.input_f32.as_mut_ptr()
}

/// Resample the `n` float samples written at `rs_stream_input_f32`. Returns
/// the number of float samples now at `rs_stream_output_f32`, or -1 on error.
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_process_f32(h: *mut Stream, n: usize) -> i32 {
    let s = &mut *h;
    let input = core::mem::take(&mut s.input_f32);
    let n = n.min(input.len());
    let ok = s.process(input[..n].iter().copied());
    s.input_f32 = input;
    s.result_f32(ok)
}

/// Float variant of `rs_stream_flush`; output at `rs_stream_output_f32`.
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_flush_f32(h: *mut Stream) -> i32 {
    let s = &mut *h;
    let ok = s.flush();
    s.result_f32(ok)
}

/// Pointer to the float output of the last `_f32` process/flush call.
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_output_f32(h: *mut Stream) -> *const f32 {
    (*h).res.as_ptr()
}

/// Discard all state (filter history, pending samples, counters).
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_reset(h: *mut Stream) {
    (*h).reset()
}

/// Filter delay in output frames (trimmed from the start of every stream).
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_delay(h: *mut Stream) -> u32 {
    (*h).delay as u32
}

/// Relative anti-aliasing cutoff (1.0 = input Nyquist; scaled down when downsampling).
///
/// # Safety
/// `h` must be a live handle from `rs_stream_new`.
#[no_mangle]
pub unsafe extern "C" fn rs_stream_cutoff(h: *mut Stream) -> f32 {
    (*h).cutoff
}

/// Sinc filter length of a quality preset (0 if unknown).
#[no_mangle]
pub extern "C" fn rs_quality_sinc_len(quality: u32) -> u32 {
    preset(quality).map(|p| p.sinc_len as u32).unwrap_or(0)
}

/// Oversampling factor of a quality preset (0 if unknown).
#[no_mangle]
pub extern "C" fn rs_quality_oversampling(quality: u32) -> u32 {
    preset(quality).map(|p| p.oversampling as u32).unwrap_or(0)
}
