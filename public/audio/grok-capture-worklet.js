class GrokCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.pending = [];
    this.position = 0;
    this.packet = [];
    this.port.onmessage = ({ data }) => {
      this.enabled = data.enabled === true;
      if (!this.enabled) {
        this.pending = [];
        this.position = 0;
        this.packet = [];
      }
    };
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!this.enabled || !input) return true;
    this.pending.push(...input);
    const step = sampleRate / 24000;
    while (this.position + 1 < this.pending.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const value = Math.max(
        -1,
        Math.min(1, this.pending[index] * (1 - fraction) + this.pending[index + 1] * fraction),
      );
      this.packet.push(Math.round(value < 0 ? value * 32768 : value * 32767));
      this.position += step;
      if (this.packet.length === 480) {
        const bytes = new ArrayBuffer(960);
        const view = new DataView(bytes);
        this.packet.forEach((sample, i) => view.setInt16(i * 2, sample, true));
        this.port.postMessage(bytes, [bytes]);
        this.packet = [];
      }
    }
    const consumed = Math.min(Math.floor(this.position), this.pending.length);
    this.pending.splice(0, consumed);
    this.position -= consumed;
    return true;
  }
}
registerProcessor('grok-capture', GrokCapture);
