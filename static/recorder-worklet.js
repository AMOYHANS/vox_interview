// 麦克风采集 AudioWorklet：把浏览器原生采样率音频下采样成 16kHz 单声道
// 每攒满 512 个 16k 样本（32ms），以 Float32Array(512) 发到主线程。
const TARGET_SR = 16000;
const BLOCK = 512;

class RecorderWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    // 分数下采样：每输入样本累加 TARGET_SR/sampleRate，攒够 1 输出一个
    this.frac = 0;
    this.sum = 0;
    this.count = 0;
    this.pool = new Float32Array(BLOCK);
    this.poolLen = 0;
  }

  _emitSample(v) {
    this.pool[this.poolLen++] = v;
    if (this.poolLen === BLOCK) {
      this.port.postMessage(this.pool);      // 传引用，主线程只读不改
      this.poolLen = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    const step = TARGET_SR / sampleRate;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.count++;
      this.frac += step;
      if (this.frac >= 1) {
        this.frac -= 1;
        this._emitSample(this.sum / this.count);
        this.sum = 0;
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor('recorder-worklet', RecorderWorklet);
