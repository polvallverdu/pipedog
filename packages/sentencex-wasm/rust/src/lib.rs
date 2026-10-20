// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Wikimedia's sentencex (MIT) behind a tiny C ABI, for wasm32-unknown-unknown.
//
// No wasm-bindgen: the JS side talks to these `extern "C"` functions through
// `WebAssembly.Instance.exports` and reads/writes linear memory directly.
//
//   ptr = sx_alloc(n)                       // JS writes UTF-8 language + text here
//   n   = sx_segment(lang, lang_len, text, text_len)
//   n   = sx_boundaries(lang, lang_len, text, text_len)
//   out = sx_out()                          // u32 records, see below
//   sx_free(ptr, n)
//
// Offsets are returned as UTF-16 code-unit indices into the text, so JS can
// `slice()` its original string without decoding anything. TextEncoder maps a
// lone surrogate to U+FFFD (one UTF-16 unit, three UTF-8 bytes), so the UTF-16
// positions still line up with the JS string in that case.
//
// Records (all u32):
//   segment:    [start16, end16] per sentence
//   boundaries: [start_index16, end_index16, text_start16, text_end16,
//                symbol_ptr, symbol_len (u32::MAX = none), is_paragraph_break]
//   start_index/end_index are sentencex's char (Unicode scalar) indices
//   converted to UTF-16; text_start/text_end locate the boundary's `text`.
//
// A negative return value means an error (bad UTF-8, or a slice that is not
// part of the input text, which sentencex never produces).

use std::alloc::{alloc, dealloc, Layout};

const BOUNDARY_FIELDS: usize = 7;
const NONE: u32 = u32::MAX;

static mut OUT: Vec<u32> = Vec::new();

#[allow(static_mut_refs)]
fn out() -> &'static mut Vec<u32> {
    // Single-threaded wasm: no concurrent access is possible.
    unsafe { &mut OUT }
}

#[no_mangle]
pub extern "C" fn sx_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut::<u8>().wrapping_add(1);
    }
    unsafe { alloc(Layout::from_size_align_unchecked(len, 1)) }
}

#[no_mangle]
pub extern "C" fn sx_free(ptr: *mut u8, len: usize) {
    if len != 0 && !ptr.is_null() {
        unsafe { dealloc(ptr, Layout::from_size_align_unchecked(len, 1)) }
    }
}

/// Pointer to the records written by the last `sx_segment` / `sx_boundaries`.
#[no_mangle]
pub extern "C" fn sx_out() -> *const u32 {
    out().as_ptr()
}

/// Maps byte offsets or char indices of `text` to UTF-16 offsets. Queries are
/// usually increasing, so it walks forward from the last position and only
/// restarts from 0 when asked about an earlier one.
struct Utf16Cursor<'a> {
    text: &'a str,
    byte: usize,
    chars: usize,
    units: usize,
}

impl<'a> Utf16Cursor<'a> {
    fn new(text: &'a str) -> Self {
        Self { text, byte: 0, chars: 0, units: 0 }
    }

    fn reset_if_past(&mut self, past: bool) {
        if past {
            self.byte = 0;
            self.chars = 0;
            self.units = 0;
        }
    }

    fn step(&mut self) -> bool {
        match self.text[self.byte..].chars().next() {
            Some(c) => {
                self.byte += c.len_utf8();
                self.chars += 1;
                self.units += c.len_utf16();
                true
            }
            None => false,
        }
    }

    fn from_byte(&mut self, byte: usize) -> u32 {
        self.reset_if_past(byte < self.byte);
        while self.byte < byte && self.step() {}
        self.units as u32
    }

    fn from_char(&mut self, chars: usize) -> u32 {
        self.reset_if_past(chars < self.chars);
        while self.chars < chars && self.step() {}
        // Past the end (never expected): extend linearly so the result is still defined.
        (self.units + (chars - self.chars)) as u32
    }
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if len == 0 {
        return Some("");
    }
    core::str::from_utf8(core::slice::from_raw_parts(ptr, len)).ok()
}

/// Byte range of `part` inside `text`, if `part` is a subslice of it.
fn range_in(text: &str, part: &str) -> Option<(usize, usize)> {
    let base = text.as_ptr() as usize;
    let start = (part.as_ptr() as usize).checked_sub(base)?;
    let end = start + part.len();
    if end > text.len() {
        return None;
    }
    Some((start, end))
}

/// Segment `text`; returns the sentence count (records in `sx_out()`), or -1.
#[no_mangle]
pub unsafe extern "C" fn sx_segment(
    lang: *const u8,
    lang_len: usize,
    text: *const u8,
    text_len: usize,
) -> i32 {
    let (Some(lang), Some(text)) = (input(lang, lang_len), input(text, text_len)) else {
        return -1;
    };
    let sentences = sentencex::segment(lang, text);
    let buf = out();
    buf.clear();
    buf.reserve(sentences.len() * 2);
    let mut cur = Utf16Cursor::new(text);
    for s in &sentences {
        let Some((start, end)) = range_in(text, s) else {
            return -2;
        };
        buf.push(cur.from_byte(start));
        buf.push(cur.from_byte(end));
    }
    sentences.len() as i32
}

/// Sentence boundaries of `text`; returns the boundary count, or -1.
#[no_mangle]
pub unsafe extern "C" fn sx_boundaries(
    lang: *const u8,
    lang_len: usize,
    text: *const u8,
    text_len: usize,
) -> i32 {
    let (Some(lang), Some(text)) = (input(lang, lang_len), input(text, text_len)) else {
        return -1;
    };
    let boundaries = sentencex::get_sentence_boundaries(lang, text);
    let buf = out();
    buf.clear();
    buf.reserve(boundaries.len() * BOUNDARY_FIELDS);
    let mut by_char = Utf16Cursor::new(text);
    let mut by_byte = Utf16Cursor::new(text);
    for b in &boundaries {
        let Some((start, end)) = range_in(text, b.text) else {
            return -2;
        };
        buf.push(by_char.from_char(b.start_index));
        buf.push(by_char.from_char(b.end_index));
        buf.push(by_byte.from_byte(start));
        buf.push(by_byte.from_byte(end));
        match b.boundary_symbol {
            Some(sym) => {
                buf.push(sym.as_ptr() as u32);
                buf.push(sym.len() as u32);
            }
            None => {
                buf.push(0);
                buf.push(NONE);
            }
        }
        buf.push(b.is_paragraph_break as u32);
    }
    boundaries.len() as i32
}
