# Models

`spleeter-vocals.fp16.onnx`: the vocals half of Deezer's [Spleeter](https://github.com/deezer/spleeter) 2-stem model (MIT licence, © Deezer), in the fp16 ONNX conversion published by the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) project (`csukuangfj/sherpa-onnx-spleeter-2stems-fp16` on Hugging Face, Apache-2.0).

SHA-256 `24cef84aedcd1fe87c0b743ef3370ad34dc1fabf6c9014d6128a75a538c7b668`

It's loaded by `js/vocalSeparator.js` and runs in the browser with onnxruntime-web. If the file changes, give it a new name: unlike the scripts, it isn't version-stamped on deploy.
