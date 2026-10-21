import{_ as e,c as t,d as n,l as r,m as i,n as a,p as o,r as s,s as c}from"./index-BZaSH8Hx.js";import{t as l}from"./daily-esm-p5U1ajfy.js";var u=e(i());function d(e){return e&&e.__esModule?e.default:e}function f(e,t,n,r){Object.defineProperty(e,t,{get:n,set:r,enumerable:!0,configurable:!0})}var p={};f(p,`DailyRTVIMessageType`,()=>G),f(p,`DailyTransport`,()=>q);var m=class{static floatTo16BitPCM(e){let t=new ArrayBuffer(e.length*2),n=new DataView(t),r=0;for(let t=0;t<e.length;t++,r+=2){let i=Math.max(-1,Math.min(1,e[t]));n.setInt16(r,i<0?i*32768:i*32767,!0)}return t}static mergeBuffers(e,t){let n=new Uint8Array(e.byteLength+t.byteLength);return n.set(new Uint8Array(e),0),n.set(new Uint8Array(t),e.byteLength),n.buffer}_packData(e,t){return[new Uint8Array([t,t>>8]),new Uint8Array([t,t>>8,t>>16,t>>24])][e]}pack(e,t){if(!t?.bitsPerSample)throw Error(`Missing "bitsPerSample"`);if(!t?.channels)throw Error(`Missing "channels"`);if(!t?.data)throw Error(`Missing "data"`);let{bitsPerSample:n,channels:r,data:i}=t,a=[`RIFF`,this._packData(1,52),`WAVE`,`fmt `,this._packData(1,16),this._packData(0,1),this._packData(0,r.length),this._packData(1,e),this._packData(1,e*r.length*n/8),this._packData(0,r.length*n/8),this._packData(0,n),`data`,this._packData(1,r[0].length*r.length*n/8),i],o=new Blob(a,{type:`audio/mpeg`});return{blob:o,url:URL.createObjectURL(o),channelCount:r.length,sampleRate:e,duration:i.byteLength/(r.length*e*2)}}};globalThis.WavPacker=m;var h=[4186.01,4434.92,4698.63,4978.03,5274.04,5587.65,5919.91,6271.93,6644.88,7040,7458.62,7902.13],g=[`C`,`C#`,`D`,`D#`,`E`,`F`,`F#`,`G`,`G#`,`A`,`A#`,`B`],_=[],v=[];for(let e=1;e<=8;e++)for(let t=0;t<h.length;t++){let n=h[t];_.push(n/2**(8-e)),v.push(g[t]+e)}var y=[32,2e3],b=_.filter((e,t)=>_[t]>y[0]&&_[t]<y[1]),x=v.filter((e,t)=>_[t]>y[0]&&_[t]<y[1]),S=class e{static getFrequencies(e,t,n,r=`frequency`,i=-100,a=-30){n||(n=new Float32Array(e.frequencyBinCount),e.getFloatFrequencyData(n));let o=t/2,s=1/n.length*o,c,l,u;if(r===`music`||r===`voice`){let e=r===`voice`?b:_,t=Array(e.length).fill(i);for(let r=0;r<n.length;r++){let i=r*s,a=n[r];for(let n=e.length-1;n>=0;n--)if(i>e[n]){t[n]=Math.max(t[n],a);break}}c=t,l=r===`voice`?b:_,u=r===`voice`?x:v}else c=Array.from(n),l=c.map((e,t)=>s*t),u=l.map(e=>`${e.toFixed(2)} Hz`);let d=c.map(e=>Math.max(0,Math.min((e-i)/(a-i),1)));return{values:new Float32Array(d),frequencies:l,labels:u}}constructor(e,t=null){if(this.fftResults=[],t){let{length:n,sampleRate:r}=t,i=new OfflineAudioContext({length:n,sampleRate:r}),a=i.createBufferSource();a.buffer=t;let o=i.createAnalyser();o.fftSize=8192,o.smoothingTimeConstant=.1,a.connect(o);let s=n/r,c=e=>{let t=.016666666666666666*e;t<s&&i.suspend(t).then(()=>{let t=new Float32Array(o.frequencyBinCount);o.getFloatFrequencyData(t),this.fftResults.push(t),c(e+1)}),e===1?i.startRendering():i.resume()};a.start(0),c(1),this.audio=e,this.context=i,this.analyser=o,this.sampleRate=r,this.audioBuffer=t}else{let t=new AudioContext,n=t.createMediaElementSource(e),r=t.createAnalyser();r.fftSize=8192,r.smoothingTimeConstant=.1,n.connect(r),r.connect(t.destination),this.audio=e,this.context=t,this.analyser=r,this.sampleRate=this.context.sampleRate,this.audioBuffer=null}}getFrequencies(t=`frequency`,n=-100,r=-30){let i=null;if(this.audioBuffer&&this.fftResults.length){let e=this.audio.currentTime/this.audio.duration,t=Math.min(e*this.fftResults.length|0,this.fftResults.length-1);i=this.fftResults[t]}return e.getFrequencies(this.analyser,this.sampleRate,i,t,n,r)}async resumeIfSuspended(){return this.context.state===`suspended`&&await this.context.resume(),!0}};globalThis.AudioAnalysis=S;var C=new Blob([`
class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hasStarted = false;
    this.hasInterrupted = false;
    this.outputBuffers = [];
    this.bufferLength = 128;
    this.write = { buffer: new Float32Array(this.bufferLength), trackId: null };
    this.writeOffset = 0;
    this.trackSampleOffsets = {};
    this.port.onmessage = (event) => {
      if (event.data) {
        const payload = event.data;
        if (payload.event === 'write') {
          const int16Array = payload.buffer;
          const float32Array = new Float32Array(int16Array.length);
          for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 0x8000; // Convert Int16 to Float32
          }
          this.writeData(float32Array, payload.trackId);
        } else if (
          payload.event === 'offset' ||
          payload.event === 'interrupt'
        ) {
          const requestId = payload.requestId;
          const trackId = this.write.trackId;
          const offset = this.trackSampleOffsets[trackId] || 0;
          this.port.postMessage({
            event: 'offset',
            requestId,
            trackId,
            offset,
          });
          if (payload.event === 'interrupt') {
            this.hasInterrupted = true;
          }
        } else {
          throw new Error(\`Unhandled event "\${payload.event}"\`);
        }
      }
    };
  }

  writeData(float32Array, trackId = null) {
    let { buffer } = this.write;
    let offset = this.writeOffset;
    for (let i = 0; i < float32Array.length; i++) {
      buffer[offset++] = float32Array[i];
      if (offset >= buffer.length) {
        this.outputBuffers.push(this.write);
        this.write = { buffer: new Float32Array(this.bufferLength), trackId };
        buffer = this.write.buffer;
        offset = 0;
      }
    }
    this.writeOffset = offset;
    return true;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const outputChannelData = output[0];
    const outputBuffers = this.outputBuffers;
    if (this.hasInterrupted) {
      this.port.postMessage({ event: 'stop' });
      return false;
    } else if (outputBuffers.length) {
      this.hasStarted = true;
      const { buffer, trackId } = outputBuffers.shift();
      for (let i = 0; i < outputChannelData.length; i++) {
        outputChannelData[i] = buffer[i] || 0;
      }
      if (trackId) {
        this.trackSampleOffsets[trackId] =
          this.trackSampleOffsets[trackId] || 0;
        this.trackSampleOffsets[trackId] += buffer.length;
      }
      return true;
    } else if (this.hasStarted) {
      this.port.postMessage({ event: 'stop' });
      return false;
    } else {
      return true;
    }
  }
}

registerProcessor('stream_processor', StreamProcessor);
`],{type:`application/javascript`}),w=URL.createObjectURL(C);globalThis.WavStreamPlayer=class{constructor({sampleRate:e=44100}={}){this.scriptSrc=w,this.sampleRate=e,this.context=null,this.stream=null,this.analyser=null,this.trackSampleOffsets={},this.interruptedTrackIds={}}async connect(){this.context=new AudioContext({sampleRate:this.sampleRate}),this._speakerID&&this.context.setSinkId(this._speakerID),this.context.state===`suspended`&&await this.context.resume();try{await this.context.audioWorklet.addModule(this.scriptSrc)}catch(e){throw console.error(e),Error(`Could not add audioWorklet module: ${this.scriptSrc}`)}let e=this.context.createAnalyser();return e.fftSize=8192,e.smoothingTimeConstant=.1,this.analyser=e,!0}getFrequencies(e=`frequency`,t=-100,n=-30){if(!this.analyser)throw Error(`Not connected, please call .connect() first`);return S.getFrequencies(this.analyser,this.sampleRate,null,e,t,n)}async updateSpeaker(e){let t=this._speakerID;if(this._speakerID=e,this.context)try{e==="default"?await this.context.setSinkId():await this.context.setSinkId(e)}catch(n){console.error(`Could not set sinkId to ${e}: ${n}`),this._speakerID=t}}_start(){let e=new AudioWorkletNode(this.context,`stream_processor`);return e.connect(this.context.destination),e.port.onmessage=t=>{let{event:n}=t.data;if(n===`stop`)e.disconnect(),this.stream=null;else if(n===`offset`){let{requestId:e,trackId:n,offset:r}=t.data,i=r/this.sampleRate;this.trackSampleOffsets[e]={trackId:n,offset:r,currentTime:i}}},this.analyser.disconnect(),e.connect(this.analyser),this.stream=e,!0}add16BitPCM(e,t=`default`){if(typeof t!=`string`)throw Error(`trackId must be a string`);if(this.interruptedTrackIds[t])return;this.stream||this._start();let n;if(e instanceof Int16Array)n=e;else if(e instanceof ArrayBuffer)n=new Int16Array(e);else throw Error(`argument must be Int16Array or ArrayBuffer`);return this.stream.port.postMessage({event:`write`,buffer:n,trackId:t}),n}async getTrackSampleOffset(e=!1){if(!this.stream)return null;let t=crypto.randomUUID();this.stream.port.postMessage({event:e?`interrupt`:`offset`,requestId:t});let n;for(;!n;)n=this.trackSampleOffsets[t],await new Promise(e=>setTimeout(()=>e(),1));let{trackId:r}=n;return e&&r&&(this.interruptedTrackIds[r]=!0),n}async interrupt(){return this.getTrackSampleOffset(!0)}};var T=new Blob([`
class AudioProcessor extends AudioWorkletProcessor {

  constructor() {
    super();
    this.port.onmessage = this.receive.bind(this);
    this.initialize();
  }

  initialize() {
    this.foundAudio = false;
    this.recording = false;
    this.chunks = [];
  }

  /**
   * Concatenates sampled chunks into channels
   * Format is chunk[Left[], Right[]]
   */
  readChannelData(chunks, channel = -1, maxChannels = 9) {
    let channelLimit;
    if (channel !== -1) {
      if (chunks[0] && chunks[0].length - 1 < channel) {
        throw new Error(
          \`Channel \${channel} out of range: max \${chunks[0].length}\`
        );
      }
      channelLimit = channel + 1;
    } else {
      channel = 0;
      channelLimit = Math.min(chunks[0] ? chunks[0].length : 1, maxChannels);
    }
    const channels = [];
    for (let n = channel; n < channelLimit; n++) {
      const length = chunks.reduce((sum, chunk) => {
        return sum + chunk[n].length;
      }, 0);
      const buffers = chunks.map((chunk) => chunk[n]);
      const result = new Float32Array(length);
      let offset = 0;
      for (let i = 0; i < buffers.length; i++) {
        result.set(buffers[i], offset);
        offset += buffers[i].length;
      }
      channels[n] = result;
    }
    return channels;
  }

  /**
   * Combines parallel audio data into correct format,
   * channels[Left[], Right[]] to float32Array[LRLRLRLR...]
   */
  formatAudioData(channels) {
    if (channels.length === 1) {
      // Simple case is only one channel
      const float32Array = channels[0].slice();
      const meanValues = channels[0].slice();
      return { float32Array, meanValues };
    } else {
      const float32Array = new Float32Array(
        channels[0].length * channels.length
      );
      const meanValues = new Float32Array(channels[0].length);
      for (let i = 0; i < channels[0].length; i++) {
        const offset = i * channels.length;
        let meanValue = 0;
        for (let n = 0; n < channels.length; n++) {
          float32Array[offset + n] = channels[n][i];
          meanValue += channels[n][i];
        }
        meanValues[i] = meanValue / channels.length;
      }
      return { float32Array, meanValues };
    }
  }

  /**
   * Converts 32-bit float data to 16-bit integers
   */
  floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  /**
   * Retrieves the most recent amplitude values from the audio stream
   * @param {number} channel
   */
  getValues(channel = -1) {
    const channels = this.readChannelData(this.chunks, channel);
    const { meanValues } = this.formatAudioData(channels);
    return { meanValues, channels };
  }

  /**
   * Exports chunks as an audio/wav file
   */
  export() {
    const channels = this.readChannelData(this.chunks);
    const { float32Array, meanValues } = this.formatAudioData(channels);
    const audioData = this.floatTo16BitPCM(float32Array);
    return {
      meanValues: meanValues,
      audio: {
        bitsPerSample: 16,
        channels: channels,
        data: audioData,
      },
    };
  }

  receive(e) {
    const { event, id } = e.data;
    let receiptData = {};
    switch (event) {
      case 'start':
        this.recording = true;
        break;
      case 'stop':
        this.recording = false;
        break;
      case 'clear':
        this.initialize();
        break;
      case 'export':
        receiptData = this.export();
        break;
      case 'read':
        receiptData = this.getValues();
        break;
      default:
        break;
    }
    // Always send back receipt
    this.port.postMessage({ event: 'receipt', id, data: receiptData });
  }

  sendChunk(chunk) {
    const channels = this.readChannelData([chunk]);
    const { float32Array, meanValues } = this.formatAudioData(channels);
    const rawAudioData = this.floatTo16BitPCM(float32Array);
    const monoAudioData = this.floatTo16BitPCM(meanValues);
    this.port.postMessage({
      event: 'chunk',
      data: {
        mono: monoAudioData,
        raw: rawAudioData,
      },
    });
  }

  process(inputList, outputList, parameters) {
    // Copy input to output (e.g. speakers)
    // Note that this creates choppy sounds with Mac products
    const sourceLimit = Math.min(inputList.length, outputList.length);
    for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
      const input = inputList[inputNum];
      const output = outputList[inputNum];
      const channelCount = Math.min(input.length, output.length);
      for (let channelNum = 0; channelNum < channelCount; channelNum++) {
        input[channelNum].forEach((sample, i) => {
          output[channelNum][i] = sample;
        });
      }
    }
    const inputs = inputList[0];
    // There's latency at the beginning of a stream before recording starts
    // Make sure we actually receive audio data before we start storing chunks
    let sliceIndex = 0;
    if (!this.foundAudio) {
      for (const channel of inputs) {
        sliceIndex = 0; // reset for each channel
        if (this.foundAudio) {
          break;
        }
        if (channel) {
          for (const value of channel) {
            if (value !== 0) {
              // find only one non-zero entry in any channel
              this.foundAudio = true;
              break;
            } else {
              sliceIndex++;
            }
          }
        }
      }
    }
    if (inputs && inputs[0] && this.foundAudio && this.recording) {
      // We need to copy the TypedArray, because the \`process\`
      // internals will reuse the same buffer to hold each input
      const chunk = inputs.map((input) => input.slice(sliceIndex));
      this.chunks.push(chunk);
      this.sendChunk(chunk);
    }
    return true;
  }
}

registerProcessor('audio_processor', AudioProcessor);
`],{type:`application/javascript`}),E=URL.createObjectURL(T);globalThis.WavRecorder=class{constructor({sampleRate:e=44100,outputToSpeakers:t=!1,debug:n=!1}={}){this.scriptSrc=E,this.sampleRate=e,this.outputToSpeakers=t,this.debug=!!n,this._deviceChangeCallback=null,this._deviceErrorCallback=null,this._devices=[],this.deviceSelection=null,this.stream=null,this.processor=null,this.source=null,this.node=null,this.recording=!1,this._lastEventId=0,this.eventReceipts={},this.eventTimeout=5e3,this._chunkProcessor=()=>{},this._chunkProcessorSize=void 0,this._chunkProcessorBuffer={raw:new ArrayBuffer(0),mono:new ArrayBuffer(0)}}static async decode(e,t=44100,n=-1){let r=new AudioContext({sampleRate:t}),i,a;if(e instanceof Blob){if(n!==-1)throw Error(`Can not specify "fromSampleRate" when reading from Blob`);a=e,i=await a.arrayBuffer()}else if(e instanceof ArrayBuffer){if(n!==-1)throw Error(`Can not specify "fromSampleRate" when reading from ArrayBuffer`);i=e,a=new Blob([i],{type:`audio/wav`})}else{let t,r;if(e instanceof Int16Array){r=e,t=new Float32Array(e.length);for(let n=0;n<e.length;n++)t[n]=e[n]/32768}else if(e instanceof Float32Array)t=e;else if(e instanceof Array)t=new Float32Array(e);else throw Error(`"audioData" must be one of: Blob, Float32Arrray, Int16Array, ArrayBuffer, Array<number>`);if(n===-1)throw Error(`Must specify "fromSampleRate" when reading from Float32Array, In16Array or Array`);if(n<3e3)throw Error(`Minimum "fromSampleRate" is 3000 (3kHz)`);r||=m.floatTo16BitPCM(t);let o={bitsPerSample:16,channels:[t],data:r};a=new m().pack(n,o).blob,i=await a.arrayBuffer()}let o=await r.decodeAudioData(i),s=o.getChannelData(0),c=URL.createObjectURL(a);return{blob:a,url:c,values:s,audioBuffer:o}}log(){return this.debug&&this.log(...arguments),!0}getSampleRate(){return this.sampleRate}getStatus(){return this.processor?this.recording?`recording`:`paused`:`ended`}async _event(e,t={},n=null){if(n||=this.processor,!n)throw Error(`Can not send events without recording first`);let r={event:e,id:this._lastEventId++,data:t};n.port.postMessage(r);let i=new Date().valueOf();for(;!this.eventReceipts[r.id];){if(new Date().valueOf()-i>this.eventTimeout)throw Error(`Timeout waiting for "${e}" event`);await new Promise(e=>setTimeout(()=>e(!0),1))}let a=this.eventReceipts[r.id];return delete this.eventReceipts[r.id],a}listenForDeviceChange(e){if(e===null&&this._deviceChangeCallback)navigator.mediaDevices.removeEventListener(`devicechange`,this._deviceChangeCallback),this._deviceChangeCallback=null;else if(e!==null){let t=0,n=[],r=e=>e.map(e=>e.deviceId).sort().join(`,`),i=async()=>{let i=++t,a=await this.listDevices();i===t&&r(n)!==r(a)&&(n=a,e(a.slice()))};navigator.mediaDevices.addEventListener(`devicechange`,i),i(),this._deviceChangeCallback=i}return!0}listenForDeviceErrors(e){this._deviceErrorCallback=e}async requestPermission(){let e=await navigator.permissions.query({name:`microphone`});if(e.state===`denied`)this._deviceErrorCallback&&this._deviceErrorCallback({devices:[`mic`],type:`unknown`,error:Error(`Microphone access denied`)});else if(e.state===`prompt`)try{(await navigator.mediaDevices.getUserMedia({audio:!0})).getTracks().forEach(e=>e.stop())}catch(e){console.error(`Error accessing microphone.`),this._deviceErrorCallback&&this._deviceErrorCallback({devices:[`mic`],type:`unknown`,error:e})}return!0}async listDevices(){if(!navigator.mediaDevices||!(`enumerateDevices`in navigator.mediaDevices))throw Error(`Could not request user devices`);return await this.requestPermission(),(await navigator.mediaDevices.enumerateDevices()).filter(e=>e.kind===`audioinput`)}async begin(e){if(this.processor)throw Error(`Already connected: please call .end() to start a new session`);if(!navigator.mediaDevices||!(`getUserMedia`in navigator.mediaDevices))throw this._deviceErrorCallback&&this._deviceErrorCallback({devices:[`mic`,`cam`],type:`undefined-mediadevices`}),Error(`Could not request user media`);e??=this.deviceSelection?.deviceId;try{let t={audio:!0};e&&(t.audio={deviceId:{exact:e}}),this.stream=await navigator.mediaDevices.getUserMedia(t)}catch(e){throw this._deviceErrorCallback&&this._deviceErrorCallback({devices:[`mic`],type:`unknown`,error:e}),Error(`Could not start media stream`)}this.listDevices().then(t=>{e=this.stream.getAudioTracks()[0].getSettings().deviceId,console.log(`find current device`,t,e,this.stream.getAudioTracks()[0].getSettings()),this.deviceSelection=t.find(t=>t.deviceId===e),console.log(`current device`,this.deviceSelection)});let t=new AudioContext({sampleRate:this.sampleRate}),n=t.createMediaStreamSource(this.stream);try{await t.audioWorklet.addModule(this.scriptSrc)}catch(e){throw console.error(e),Error(`Could not add audioWorklet module: ${this.scriptSrc}`)}let r=new AudioWorkletNode(t,`audio_processor`);r.port.onmessage=e=>{let{event:t,id:n,data:r}=e.data;if(t===`receipt`)this.eventReceipts[n]=r;else if(t===`chunk`)if(this._chunkProcessorSize){let e=this._chunkProcessorBuffer;this._chunkProcessorBuffer={raw:m.mergeBuffers(e.raw,r.raw),mono:m.mergeBuffers(e.mono,r.mono)},this._chunkProcessorBuffer.mono.byteLength>=this._chunkProcessorSize&&(this._chunkProcessor(this._chunkProcessorBuffer),this._chunkProcessorBuffer={raw:new ArrayBuffer(0),mono:new ArrayBuffer(0)})}else this._chunkProcessor(r)};let i=n.connect(r),a=t.createAnalyser();return a.fftSize=8192,a.smoothingTimeConstant=.1,i.connect(a),this.outputToSpeakers&&(console.warn(`Warning: Output to speakers may affect sound quality,
especially due to system audio feedback preventative measures.
use only for debugging`),a.connect(t.destination)),this.source=n,this.node=i,this.analyser=a,this.processor=r,console.log(`begin completed`),!0}getFrequencies(e=`frequency`,t=-100,n=-30){if(!this.processor)throw Error(`Session ended: please call .begin() first`);return S.getFrequencies(this.analyser,this.sampleRate,null,e,t,n)}async pause(){if(!this.processor)throw Error(`Session ended: please call .begin() first`);if(!this.recording)throw Error(`Already paused: please call .record() first`);return this._chunkProcessorBuffer.raw.byteLength&&this._chunkProcessor(this._chunkProcessorBuffer),this.log(`Pausing ...`),await this._event(`stop`),this.recording=!1,!0}async record(e=()=>{},t=8192){if(!this.processor)throw Error(`Session ended: please call .begin() first`);if(this.recording)throw Error(`Already recording: please call .pause() first`);if(typeof e!=`function`)throw Error(`chunkProcessor must be a function`);return this._chunkProcessor=e,this._chunkProcessorSize=t,this._chunkProcessorBuffer={raw:new ArrayBuffer(0),mono:new ArrayBuffer(0)},this.log(`Recording ...`),await this._event(`start`),this.recording=!0,!0}async clear(){if(!this.processor)throw Error(`Session ended: please call .begin() first`);return await this._event(`clear`),!0}async read(){if(!this.processor)throw Error(`Session ended: please call .begin() first`);return this.log(`Reading ...`),await this._event(`read`)}async save(e=!1){if(!this.processor)throw Error(`Session ended: please call .begin() first`);if(!e&&this.recording)throw Error(`Currently recording: please call .pause() first, or call .save(true) to force`);this.log(`Exporting ...`);let t=await this._event(`export`);return new m().pack(this.sampleRate,t.audio)}async end(){if(!this.processor)throw Error(`Session ended: please call .begin() first`);let e=this.processor;this.log(`Stopping ...`),await this._event(`stop`),this.recording=!1,this.stream.getTracks().forEach(e=>e.stop()),this.log(`Exporting ...`);let t=await this._event(`export`,{},e);return this.processor.disconnect(),this.source.disconnect(),this.node.disconnect(),this.analyser.disconnect(),this.stream=null,this.processor=null,this.source=null,this.node=null,new m().pack(this.sampleRate,t.audio)}async quit(){return this.listenForDeviceChange(null),this.deviceSelection=null,this.processor&&await this.end(),!0}};function D(e,t,n){if(t===n)return e;let r=new Int16Array(e),i=t/n,a=Math.round(r.length/i),o=new ArrayBuffer(a*2),s=new Int16Array(o);for(let e=0;e<a;e++){let t=e*i,n=Math.floor(t),a=Math.min(n+1,r.length-1),o=t-n;s[e]=Math.round(r[n]*(1-o)+r[a]*o)}return o}var O=class{constructor({sampleRate:e=44100,outputToSpeakers:t=!1,debug:n=!1}={}){this.scriptSrc=E,this.sampleRate=e,this.outputToSpeakers=t,this.debug=!!n,this.stream=null,this.processor=null,this.source=null,this.node=null,this.recording=!1,this._lastEventId=0,this.eventReceipts={},this.eventTimeout=5e3,this._chunkProcessor=()=>{},this._chunkProcessorSize=void 0,this._chunkProcessorBuffer={raw:new ArrayBuffer(0),mono:new ArrayBuffer(0)}}log(){return this.debug&&this.log(...arguments),!0}getSampleRate(){return this.sampleRate}getStatus(){return this.processor?this.recording?`recording`:`paused`:`ended`}async _event(e,t={},n=null){if(n||=this.processor,!n)throw Error(`Can not send events without recording first`);let r={event:e,id:this._lastEventId++,data:t};n.port.postMessage(r);let i=new Date().valueOf();for(;!this.eventReceipts[r.id];){if(new Date().valueOf()-i>this.eventTimeout)throw Error(`Timeout waiting for "${e}" event`);await new Promise(e=>setTimeout(()=>e(!0),1))}let a=this.eventReceipts[r.id];return delete this.eventReceipts[r.id],a}async begin(e){if(this.processor)throw Error(`Already connected: please call .end() to start a new session`);if(!e||e.kind!==`audio`)throw Error(`No audio track provided`);this.stream=new MediaStream([e]);let t=navigator.userAgent.toLowerCase().includes(`firefox`),n;n=t?new AudioContext:new AudioContext({sampleRate:this.sampleRate});let r=n.sampleRate,i=n.createMediaStreamSource(this.stream);try{await n.audioWorklet.addModule(this.scriptSrc)}catch(e){throw console.error(e),Error(`Could not add audioWorklet module: ${this.scriptSrc}`)}let a=new AudioWorkletNode(n,`audio_processor`);a.port.onmessage=e=>{let{event:t,id:n,data:i}=e.data;if(t===`receipt`)this.eventReceipts[n]=i;else if(t===`chunk`){let e={raw:D(i.raw,r,this.sampleRate),mono:D(i.mono,r,this.sampleRate)};if(this._chunkProcessorSize){let t=this._chunkProcessorBuffer;this._chunkProcessorBuffer={raw:m.mergeBuffers(t.raw,e.raw),mono:m.mergeBuffers(t.mono,e.mono)},this._chunkProcessorBuffer.mono.byteLength>=this._chunkProcessorSize&&(this._chunkProcessor(this._chunkProcessorBuffer),this._chunkProcessorBuffer={raw:new ArrayBuffer(0),mono:new ArrayBuffer(0)})}else this._chunkProcessor(e)}};let o=i.connect(a),s=n.createAnalyser();return s.fftSize=8192,s.smoothingTimeConstant=.1,o.connect(s),this.outputToSpeakers&&(console.warn(`Warning: Output to speakers may affect sound quality,
especially due to system audio feedback preventative measures.
use only for debugging`),s.connect(n.destination)),this.source=i,this.node=o,this.analyser=s,this.processor=a,!0}getFrequencies(e=`frequency`,t=-100,n=-30){if(!this.processor)throw Error(`Session ended: please call .begin() first`);return S.getFrequencies(this.analyser,this.sampleRate,null,e,t,n)}async pause(){if(!this.processor)throw Error(`Session ended: please call .begin() first`);if(!this.recording)throw Error(`Already paused: please call .record() first`);return this._chunkProcessorBuffer.raw.byteLength&&this._chunkProcessor(this._chunkProcessorBuffer),this.log(`Pausing ...`),await this._event(`stop`),this.recording=!1,!0}async record(e=()=>{},t=8192){if(!this.processor)throw Error(`Session ended: please call .begin() first`);if(this.recording)throw Error(`Already recording: HELLO please call .pause() first`);if(typeof e!=`function`)throw Error(`chunkProcessor must be a function`);return this._chunkProcessor=e,this._chunkProcessorSize=t,this._chunkProcessorBuffer={raw:new ArrayBuffer(0),mono:new ArrayBuffer(0)},this.log(`Recording ...`),await this._event(`start`),this.recording=!0,!0}async clear(){if(!this.processor)throw Error(`Session ended: please call .begin() first`);return await this._event(`clear`),!0}async read(){if(!this.processor)throw Error(`Session ended: please call .begin() first`);return this.log(`Reading ...`),await this._event(`read`)}async save(e=!1){if(!this.processor)throw Error(`Session ended: please call .begin() first`);if(!e&&this.recording)throw Error(`Currently recording: please call .pause() first, or call .save(true) to force`);this.log(`Exporting ...`);let t=await this._event(`export`);return new m().pack(this.sampleRate,t.audio)}async end(){if(!this.processor)throw Error(`Session ended: please call .begin() first`);let e=this.processor;this.log(`Stopping ...`),await this._event(`stop`),this.recording=!1,this.log(`Exporting ...`);let t=await this._event(`export`,{},e);return this.processor.disconnect(),this.source.disconnect(),this.node.disconnect(),this.analyser.disconnect(),this.stream=null,this.processor=null,this.source=null,this.node=null,new m().pack(this.sampleRate,t.audio)}async quit(){return this.listenForDeviceChange(null),this.processor&&await this.end(),!0}};globalThis.WavRecorder=WavRecorder;var k=[`CONNECTING`,`OPEN`,`CLOSING`,`CLOSED`],A=5e3,j=15e3,M=15e4,N=2,P=10,F=1e3,I=3e4,L=1.5,R=4100,z=`SIG_CONNECTION_CANCELED`,B=`WEBSOCKET_ERROR`,V;(function(e){e[e.DEBUG=0]=`DEBUG`,e[e.ERROR=1]=`ERROR`,e[e.INFO=2]=`INFO`,e[e.WARN=3]=`WARN`})(V||={});var H=class{constructor(e,t){this._closedManually=!1,this._errored=!1,this._rejected=!1,this._timed_out=!1,this._initialConnectionOk=!1,this._ws=new WebSocket(e,t)}addEventListener(e,t){this._ws.addEventListener(e,t)}close(e,t){this._ws.close(e,t)}send(e){this._ws.send(e)}get url(){return this._ws.url}get readyState(){return this._ws.readyState}},U=class extends u.EventEmitter{constructor(e,t,n={}){if(super(),!e)throw Error(`Need a valid WebSocket URL`);this._ws=null,this._url=e,this._protocols=t,this._parseBlobToJson=n?.parseBlobToJson??!0,this.init()}init(){this._keepAliveTimeout=j,this._keepAliveInterval=A,this._disconnected=!1,this._keepIntervalID=null,this._shouldRetryFn=null,this._connectionTimeout=M,this._reconnectAttempts=0,this._allowedReconnectAttempts=N,this._reconnectInterval=F,this._maxReconnectInterval=I,this._reconnectDecay=L}async connect(){return new Promise((e,t)=>{this._disconnected=!1,this.clearReconnectTimeout();let n=new H(this._url,this._protocols);this.setConnectionTimeout(),n.addEventListener(`close`,e=>{let r=e,i=n._timed_out?R:r.code,a=n._timed_out?`websocket connection timed out`:r.reason;if(n._timed_out=!1,!n._closedManually&&n._initialConnectionOk?(console.warn(`signaling socket closed unexpectedly: ${i}${a?` `+a:``}`),this._closeSocket(),this.emit(`close`,i,a)):this.log(`signaling socket closed`),!n._closedManually&&(n._errored||n._timed_out)&&(console.warn(`signaling socket closed on error: ${i}${a?` `+a:``}`),!n._rejected)){n._rejected=!0;let e=Error(`WebSocket connection error (${i}): ${a}`);e.name=B,t(e)}}),n.addEventListener(`open`,r=>{if(this.log(`wss connection opened to`,V.DEBUG,this._url),this.clearConnectionTimeout(),!(n._rejected||n._timed_out)){if(n._closedManually||this._ws&&this._ws!==n){n._rejected=!0,n.close();let e=Error(`wss connection interrupted by disconnect or newer connection`);e.name=z,t(e);return}n._initialConnectionOk=this._url,this._lastMsgRecvTime=Date.now(),this._keepAliveInterval&&(this._keepIntervalID=setInterval(()=>this.checkSocketHealthAndSendKeepAlive(),this._keepAliveInterval)),this._ws=n,this.emit(`open`),e(n)}}),n.addEventListener(`error`,e=>{if(!n._closedManually){let t=e.currentTarget;this.log(`websocket error event: ${t?.url}`)}n._errored=!0}),n.addEventListener(`message`,e=>{this._handleMessage(e)})})}setConnectionTimeout(){this._connectionTimeoutID=setTimeout(async()=>{this.log(`Connection reconnect attempt timed out.`),this.emit(`connection-timeout`),this.clearConnectionTimeout(),await this._closeSocket()},this._connectionTimeout)}clearConnectionTimeout(){clearTimeout(this._connectionTimeoutID),this._connectionTimeoutID=void 0}clearReconnectTimeout(){clearTimeout(this._reconnectTimeoutID),this._reconnectTimeoutID=void 0}clearKeepAliveInterval(){this._keepIntervalID&&=(clearInterval(this._keepIntervalID),null)}async checkSocketHealthAndSendKeepAlive(){if(this._ws&&this._ws.readyState===WebSocket.OPEN&&!(!this._keepAliveTimeout||!this._keepAliveInterval)){if(Date.now()-this._lastMsgRecvTime>this._keepAliveTimeout){this.log(`Connection is stale, need to reconnect`,V.WARN),await this._closeSocket();return}Date.now()-this._lastMsgSendTime<this._keepAliveInterval||(this.log(`Emitting keep-alive`,V.DEBUG),this.emit(`keep-alive`))}}async _closeSocket(){this.log(`Closing`);try{this.clearKeepAliveInterval(),this._lastMsgRecvTime=0,this._ws&&(this._ws._closedManually=!0,this._ws.close());let e=this._ws?._initialConnectionOk&&this._shouldRetryFn&&this._shouldRetryFn();this._ws=null,e&&(this.log(`Emitting reconnect`,V.DEBUG),this.emit(`reconnecting`),await this.retryFailedConnection())}catch(e){this.log(`Error while closing and retrying: ${e}`,V.ERROR)}}async retryFailedConnection(){if(this._reconnectAttempts<this._allowedReconnectAttempts){if(this._reconnectTimeoutID){this.log(`Retry already scheduled`);return}this.log(`Retrying failed connection`);let e=this._reconnectInterval*this._reconnectDecay**+this._reconnectAttempts;e=e>this._maxReconnectInterval?this._maxReconnectInterval:e,this.log(`Reconnecting in ${e/1e3} seconds`),this._reconnectAttempts+=1,this._reconnectTimeoutID=setTimeout(()=>this.connect(),e)}else this.log(`Maximum connection retry attempts exceeded`,V.ERROR),this.emit(`reconnect-failed`)}log(e,t=V.DEBUG,...n){switch(t){case V.DEBUG:console.debug(`websocket: ${e}`,...n);break;case V.ERROR:console.error(`websocket: ${e}`,...n);break;case V.WARN:console.warn(`websocket: ${e}`,...n);break;case V.INFO:default:console.log(`websocket: ${e}`,...n);break}}async send(e){try{this._ws&&this._ws.readyState===WebSocket.OPEN?(this._lastMsgSendTime=Date.now(),this._ws.send(e)):this.log(`Failed to send data, web socket not open.`,V.ERROR)}catch(e){this.log(`Failed to send data. ${e}`,V.ERROR)}}async close(){try{this.log(`Closing websocket`),this._disconnected=!0,this.clearReconnectTimeout(),this._closeSocket()}catch(e){this.log(`Failed to close websocket. ${e}`)}}get readyState(){return this._ws?.readyState??WebSocket.CLOSED}get url(){return this._url}get keepAliveTimeout(){return this._keepAliveTimeout}set keepAliveTimeout(e){typeof e==`number`&&(this.log(`Setting ACK freshness timeout to ${e}`),this._keepAliveTimeout=e)}get keepAliveInterval(){return this._keepAliveInterval}set keepAliveInterval(e){typeof e==`number`&&(this.log(`Setting keep-alive interval to ${e}`),this._keepAliveInterval=e)}set shouldRetryFn(e){typeof e==`function`&&(this._shouldRetryFn=e)}get connectionTimeout(){return this._connectionTimeout}set connectionTimeout(e){typeof e==`number`&&(this._connectionTimeout=e)}get maxReconnectAttempts(){return this._allowedReconnectAttempts}set maxReconnectAttempts(e){e>0&&e<P?(this.log(`Setting maximum connection retry attempts to ${e}`),this._allowedReconnectAttempts=e):this._allowedReconnectAttempts=N}get reconnectInterval(){return this._reconnectInterval}set reconnectInterval(e){typeof e==`number`&&(this._reconnectInterval=e<this._maxReconnectInterval?e:this._maxReconnectInterval)}async _handleMessage(e){this._lastMsgRecvTime=Date.now();let t=e.data,n=await new Promise((e,n)=>{if(typeof t==`string`)e(t);else if(t instanceof ArrayBuffer)e(new Uint8Array(t));else if(t instanceof Blob){if(!this._parseBlobToJson){e(t);return}let n=t,r=new FileReader;r.onload=()=>{let t=r.result;try{e(JSON.parse(t))}catch(e){console.error(`Failed to parse JSON from Blob:`,e)}},r.readAsText(n)}});this.emit(`message`,n)}};[`binaryType`,`bufferedAmount`,`extensions`,`protocol`,`readyState`,`url`,`keepAliveTimeout`,`keepAliveInterval`,`shouldRetryFn`,`connectionTimeout`,`maxReconnectAttempts`,`reconnectInterval`].forEach(e=>{Object.defineProperty(U.prototype,e,{enumerable:!0})}),[`CONNECTING`,`OPEN`,`CLOSING`,`CLOSED`].forEach(e=>{Object.defineProperty(U.prototype,e,{enumerable:!0,value:k.indexOf(e)})}),[`CONNECTING`,`OPEN`,`CLOSING`,`CLOSED`].forEach(e=>{Object.defineProperty(U,e,{enumerable:!0,value:k.indexOf(e)})});var W={};W=JSON.parse(`{"name":"@pipecat-ai/daily-transport","version":"1.6.9","license":"BSD-2-Clause","main":"dist/index.js","module":"dist/index.module.js","types":"dist/index.d.ts","source":"src/index.ts","repository":{"type":"git","url":"git+https://github.com/pipecat-ai/pipecat-client-web-transports.git"},"exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.module.js","require":"./dist/index.js"}},"files":["dist","package.json","README.md"],"targets":{"main":{"includeNodeModules":["@pipecat-ai/transport-lib"]},"module":{"includeNodeModules":["@pipecat-ai/transport-lib"]}},"scripts":{"build":"parcel build --no-cache","dev":"parcel watch","lint":"eslint . --ext ts --report-unused-disable-directives --max-warnings 0"},"devDependencies":{"@pipecat-ai/client-js":"^1.13.0","@pipecat-ai/transport-lib":"^0.1.0","eslint":"9.39.1","eslint-config-prettier":"^9.1.0","eslint-plugin-simple-import-sort":"^12.1.1"},"peerDependencies":{"@pipecat-ai/client-js":"~1.13.0"},"dependencies":{"@daily-co/daily-js":"^0.90.0"},"description":"Pipecat Daily Transport Package","author":"Daily.co","bugs":{"url":"https://github.com/pipecat-ai/pipecat-client-web-transports/issues"},"homepage":"https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/transports/daily-webrtc/README.md"}`);var G;(function(e){e.AUDIO_BUFFERING_STARTED=`audio-buffering-started`,e.AUDIO_BUFFERING_STOPPED=`audio-buffering-stopped`})(G||={});var K=class{constructor(e){this._daily=e,this._proxy=new Proxy(this._daily,{get:(e,t,n)=>{if(typeof e[t]==`function`){let n;switch(String(t)){case`preAuth`:n=`Calls to preAuth() are disabled. Please use Transport.preAuth()`;break;case`startCamera`:n=`Calls to startCamera() are disabled. Please use PipecatClient.initDevices()`;break;case`join`:n=`Calls to join() are disabled. Please use PipecatClient.connect()`;break;case`leave`:n=`Calls to leave() are disabled. Please use PipecatClient.disconnect()`;break;case`destroy`:n=`Calls to destroy() are disabled.`;break}return n?()=>{throw Error(n)}:(...n)=>e[t](...n)}return Reflect.get(e,t,n)}})}get proxy(){return this._proxy}},q=class e extends a{constructor(e={}){super(),this._botId=``,this._selectedCam={},this._selectedMic={},this._selectedSpeaker={},this._currentAudioTrack=null,this._audioQueue=[],this._micEnabled=!0,this._camEnabled=!1,this._callbacks={};let{bufferLocalAudioUntilBotReady:t,...n}=e;this._dailyFactoryOptions=n,this._dailyFactoryOptions.dailyConfig?.useDevicePreferenceCookies===void 0&&(this._dailyFactoryOptions.dailyConfig??(this._dailyFactoryOptions.dailyConfig={}),this._dailyFactoryOptions.dailyConfig.useDevicePreferenceCookies=!0),this._bufferLocalAudioUntilBotReady=t||!1,this._daily=l.createCallObject({...this._dailyFactoryOptions,allowMultipleCallInstances:!0}),this._dailyWrapper=new K(this._daily)}setupRecorder(){this._mediaStreamRecorder=new O({sampleRate:e.RECORDER_SAMPLE_RATE})}handleUserAudioStream(e){this._audioQueue.push(e)}flushAudioQueue(){if(this._audioQueue.length!==0)for(o.debug(`Will flush audio queue: ${this._audioQueue.length}`);this._audioQueue.length>0;){let e=[];for(;e.length<10&&this._audioQueue.length>0;){let t=this._audioQueue.shift();t&&e.push(t)}e.length>0&&this._sendAudioBatch(e)}}_sendAudioBatch(t){let n={id:`raw-audio-batch`,label:`rtvi-ai`,type:`raw-audio-batch`,data:{base64AudioBatch:t.map(e=>{let t=new Uint8Array(e);return btoa(String.fromCharCode(...t))}),sampleRate:e.RECORDER_SAMPLE_RATE,numChannels:1}};this.sendMessage(n)}initialize(e,t){this._bufferLocalAudioUntilBotReady&&this.setupRecorder(),this._callbacks=e.callbacks??{},this._onMessage=t,(this._dailyFactoryOptions.startVideoOff==null||e.enableCam!=null)&&(this._dailyFactoryOptions.startVideoOff=!(e.enableCam??!1)),(this._dailyFactoryOptions.startAudioOff==null||e.enableMic!=null)&&(this._dailyFactoryOptions.startAudioOff=!(e.enableMic??!0)),this._camEnabled=!this._dailyFactoryOptions.startVideoOff,this._micEnabled=!this._dailyFactoryOptions.startAudioOff,this.attachEventListeners(),this.state=`disconnected`,o.debug(`[Daily Transport] Initialized`,d(W).version)}get dailyCallClient(){return this._dailyWrapper.proxy}get state(){return this._state}set state(e){this._state!==e&&(this._state=e,this._callbacks.onTransportStateChanged?.(e))}getSessionInfo(){return this._daily.meetingSessionSummary()}async getAllCams(){let{devices:e}=await this._daily.enumerateDevices();return e.filter(e=>e.kind===`videoinput`)}updateCam(e){this._daily.setInputDevicesAsync({videoDeviceId:e}).then(e=>{this._selectedCam=e.camera})}get selectedCam(){return this._selectedCam}async getAllMics(){let{devices:e}=await this._daily.enumerateDevices();return e.filter(e=>e.kind===`audioinput`)}updateMic(e){this._daily.setInputDevicesAsync({audioDeviceId:e}).then(e=>{this._selectedMic=e.mic})}get selectedMic(){return this._selectedMic}async getAllSpeakers(){let{devices:e}=await this._daily.enumerateDevices();return e.filter(e=>e.kind===`audiooutput`)}updateSpeaker(e){this._daily.setOutputDeviceAsync({outputDeviceId:e}).then(e=>{this._selectedSpeaker=e.speaker}).catch(e=>{this._callbacks.onDeviceError?.(new t([`speaker`],e.type??`unknown`,e.message))})}get selectedSpeaker(){return this._selectedSpeaker}enableMic(e){this._dailyFactoryOptions.startAudioOff=!e,this._micEnabled=e,this._daily.participants()?.local&&this._daily.setLocalAudio(e)}get isMicEnabled(){return this._micEnabled}enableCam(e){this._dailyFactoryOptions.startVideoOff=!e,this._camEnabled=e,this._daily.participants()?.local&&this._daily.setLocalVideo(e)}get isCamEnabled(){return this._camEnabled}enableScreenShare(e){e?this._daily.startScreenShare():this._daily.stopScreenShare()}get isSharingScreen(){return this._daily.localScreenAudio()||this._daily.localScreenVideo()}tracks(){let e=this._daily.participants()??{},t=e?.[this._botId],n={local:{audio:e?.local?.tracks?.audio?.persistentTrack,screenAudio:e?.local?.tracks?.screenAudio?.persistentTrack,screenVideo:e?.local?.tracks?.screenVideo?.persistentTrack,video:e?.local?.tracks?.video?.persistentTrack}};return t&&(n.bot={audio:t?.tracks?.audio?.persistentTrack,video:t?.tracks?.video?.persistentTrack}),n}async startRecording(){try{o.info(`[Daily Transport] Initializing recording`),await this._mediaStreamRecorder.record(e=>{this.handleUserAudioStream(e.mono)},e.RECORDER_CHUNK_SIZE),this._callbacks.onAudioBufferingStarted?.(),o.info(`[Daily Transport] Recording Initialized`)}catch(e){e.message.includes(`Already recording`)||o.error(`Error starting recording`,e)}}async preAuth(e){this._dailyFactoryOptions=e,await this._daily.preAuth(e)}async initDevices(){if(!this._daily)throw new c(`Transport instance not initialized`);this.state=`initializing`;let e=await this._daily.startCamera(this._dailyFactoryOptions),{devices:t}=await this._daily.enumerateDevices(),n=t.filter(e=>e.kind===`videoinput`),r=t.filter(e=>e.kind===`audioinput`),i=t.filter(e=>e.kind===`audiooutput`);this._selectedCam=e.camera,this._selectedMic=e.mic,this._selectedSpeaker=e.speaker,this._callbacks.onAvailableCamsUpdated?.(n),this._callbacks.onAvailableMicsUpdated?.(r),this._callbacks.onAvailableSpeakersUpdated?.(i),this._callbacks.onCamUpdated?.(e.camera),this._callbacks.onMicUpdated?.(e.mic),this._callbacks.onSpeakerUpdated?.(e.speaker),this._daily.isLocalAudioLevelObserverRunning()||await this._daily.startLocalAudioLevelObserver(100),this._daily.isRemoteParticipantsAudioLevelObserverRunning()||await this._daily.startRemoteParticipantsAudioLevelObserver(100),this.state=`initialized`}_validateConnectionParams(e){if(e==null)return;if(typeof e!=`object`)throw new c(`Invalid connection parameters`);let t=e;return t.room_url?(t.url=t.room_url,delete t.room_url):t.dailyRoom&&(t.url=t.dailyRoom,delete t.dailyRoom),t.dailyToken&&(t.token=t.dailyToken,delete t.dailyToken),t.token||delete t.token,t}async _connect(e){if(!this._daily)throw new c(`Transport instance not initialized`);e&&(this._dailyFactoryOptions={...this._dailyFactoryOptions,...e}),this.state=`connecting`;try{await this._daily.join(this._dailyFactoryOptions)}catch(e){throw o.error(`Failed to join room`,e),this.state=`error`,new n}if(this._abortController?.signal.aborted)return;let t=await this._daily.room();this._maxMessageSize=t?.domainConfig?.max_app_message_size||10485760,this.state=`connected`,this._callbacks.onConnected?.()}async sendReadyMessage(){return new Promise(e=>{let t=()=>{let e=navigator.userAgent;return/iPad|iPhone|iPod/.test(e)||/Macintosh/.test(e)&&`ontouchend`in document},n=()=>{this.state=`ready`,this.flushAudioQueue(),this.sendMessage(s.clientReady()),this.stopRecording(),e()};for(let t in this._daily.participants()){let r=this._daily.participants()[t];if(!r.local&&r.tracks?.audio?.persistentTrack){n(),e();return}}let r=e=>{e.participant?.local||(this._daily.off(`track-started`,r),t()?(o.debug(`[Daily Transport] iOS device detected, adding 0.5 second delay before sending ready message`),setTimeout(n,500)):n())};this._daily.on(`track-started`,r)})}stopRecording(){this._mediaStreamRecorder&&this._mediaStreamRecorder.getStatus()!==`ended`&&(this._mediaStreamRecorder.end(),this._callbacks.onAudioBufferingStopped?.())}attachEventListeners(){this._daily.on(`available-devices-updated`,this.handleAvailableDevicesUpdated.bind(this)),this._daily.on(`selected-devices-updated`,this.handleSelectedDevicesUpdated.bind(this)),this._daily.on(`camera-error`,this.handleDeviceError.bind(this)),this._daily.on(`track-started`,this.handleTrackStarted.bind(this)),this._daily.on(`track-stopped`,this.handleTrackStopped.bind(this)),this._daily.on(`participant-joined`,this.handleParticipantJoined.bind(this)),this._daily.on(`participant-left`,this.handleParticipantLeft.bind(this)),this._daily.on(`local-audio-level`,this.handleLocalAudioLevel.bind(this)),this._daily.on(`remote-participants-audio-level`,this.handleRemoteAudioLevel.bind(this)),this._daily.on(`app-message`,this.handleAppMessage.bind(this)),this._daily.on(`left-meeting`,this.handleLeftMeeting.bind(this)),this._daily.on(`error`,this.handleFatalError.bind(this)),this._daily.on(`nonfatal-error`,this.handleNonFatalError.bind(this))}async _disconnect(){this.state=`disconnecting`,this._daily.stopLocalAudioLevelObserver(),this._daily.stopRemoteParticipantsAudioLevelObserver(),this._audioQueue=[],this._currentAudioTrack=null,this.stopRecording(),await this._daily.leave()}sendMessage(e){try{this._daily.sendAppMessage(e,`*`)}catch(e){throw e instanceof Error&&e.message.includes(`Message data too large`)?new r(e.message):e}}handleAppMessage(e){e.data.label===`rtvi-ai`&&this._onMessage({id:e.data.id,type:e.data.type,data:e.data.data})}handleAvailableDevicesUpdated(e){this._callbacks.onAvailableCamsUpdated?.(e.availableDevices.filter(e=>e.kind===`videoinput`)),this._callbacks.onAvailableMicsUpdated?.(e.availableDevices.filter(e=>e.kind===`audioinput`)),this._callbacks.onAvailableSpeakersUpdated?.(e.availableDevices.filter(e=>e.kind===`audiooutput`))}handleSelectedDevicesUpdated(e){this._selectedCam?.deviceId!==e.devices.camera&&(this._selectedCam=e.devices.camera,this._callbacks.onCamUpdated?.(e.devices.camera)),this._selectedMic?.deviceId!==e.devices.mic&&(this._selectedMic=e.devices.mic,this._callbacks.onMicUpdated?.(e.devices.mic)),this._selectedSpeaker?.deviceId!==e.devices.speaker&&(this._selectedSpeaker=e.devices.speaker,this._callbacks.onSpeakerUpdated?.(e.devices.speaker))}handleDeviceError(e){let n=(e=>{let n=[];switch(e.type){case`permissions`:return e.blockedMedia.forEach(e=>{n.push(e===`video`?`cam`:`mic`)}),new t(n,e.type,e.msg,{blockedBy:e.blockedBy});case`not-found`:return e.missingMedia.forEach(e=>{n.push(e===`video`?`cam`:`mic`)}),new t(n,e.type,e.msg);case`constraints`:return e.failedMedia.forEach(e=>{n.push(e===`video`?`cam`:`mic`)}),new t(n,e.type,e.msg,{reason:e.reason});case`cam-in-use`:return n.push(`cam`),new t(n,`in-use`,e.msg);case`mic-in-use`:return n.push(`mic`),new t(n,`in-use`,e.msg);case`cam-mic-in-use`:return n.push(`cam`),n.push(`mic`),new t(n,`in-use`,e.msg);default:return n.push(`cam`),n.push(`mic`),new t(n,e.type,e.msg)}})(e.error);n.devices.includes(`mic`)&&(this._micEnabled=this._daily.localAudio()),n.devices.includes(`cam`)&&(this._camEnabled=this._daily.localVideo()),this._callbacks.onDeviceError?.(n)}async handleLocalAudioTrack(e){if(!(this.state==`ready`||!this._bufferLocalAudioUntilBotReady)){switch(this._mediaStreamRecorder.getStatus()){case`ended`:try{await this._mediaStreamRecorder.begin(e),await this.startRecording()}catch{}break;case`paused`:await this.startRecording();break;default:if(this._currentAudioTrack!==e)try{await this._mediaStreamRecorder.end(),await this._mediaStreamRecorder.begin(e),await this.startRecording()}catch{}else o.warn(`track-started event received for current track and already recording`);break}this._currentAudioTrack=e}}handleTrackStarted(e){e.type===`screenAudio`||e.type===`screenVideo`?this._callbacks.onScreenTrackStarted?.(e.track,e.participant?J(e.participant):void 0):(e.participant?.local&&(e.track.kind===`audio`?(this._micEnabled=!0,this.handleLocalAudioTrack(e.track)):e.track.kind===`video`&&(this._camEnabled=!0)),this._callbacks.onTrackStarted?.(e.track,e.participant?J(e.participant):void 0))}handleTrackStopped(e){e.type===`screenAudio`||e.type===`screenVideo`?this._callbacks.onScreenTrackStopped?.(e.track,e.participant?J(e.participant):void 0):(e.participant?.local&&(e.track.kind===`audio`?this._micEnabled=!1:e.track.kind===`video`&&(this._camEnabled=!1)),this._callbacks.onTrackStopped?.(e.track,e.participant?J(e.participant):void 0))}handleParticipantJoined(e){let t=J(e.participant);this._callbacks.onParticipantJoined?.(t),!t.local&&(this._botId=e.participant.session_id,this._callbacks.onBotConnected?.(t))}handleParticipantLeft(e){let t=J(e.participant);this._callbacks.onParticipantLeft?.(t),!t.local&&(this._botId=``,this._callbacks.onBotDisconnected?.(t))}handleLocalAudioLevel(e){this._callbacks.onLocalAudioLevel?.(e.audioLevel)}handleRemoteAudioLevel(e){let t=this._daily.participants(),n=Object.keys(e.participantsAudioLevel);for(let r=0;r<n.length;r++){let i=n[r],a=e.participantsAudioLevel[i];this._callbacks.onRemoteAudioLevel?.(a,J(t[i]))}}handleLeftMeeting(){this.state=`disconnected`,this._botId=``,this._callbacks.onDisconnected?.()}handleFatalError(e){o.error(`Daily fatal error`,e.errorMsg),this.state=`error`,this._botId=``,this._callbacks.onError?.(s.error(e.errorMsg,!0))}handleNonFatalError(e){switch(e.type){case`screen-share-error`:this._callbacks.onScreenShareError?.(e.errorMsg);break}}};q.RECORDER_SAMPLE_RATE=16e3,q.RECORDER_CHUNK_SIZE=512;var J=e=>({id:e.user_id,local:e.local,name:e.user_name});export{q as DailyTransport};