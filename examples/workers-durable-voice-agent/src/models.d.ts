// The ONNX models are bundled as data (see wrangler.jsonc): each import is its bytes.
declare module "*.onnx" {
  const model: ArrayBuffer;
  export default model;
}
