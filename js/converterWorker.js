// Runs Spotify's Basic Pitch model (the model behind NeuralNote) off the main
// thread so the page stays responsive. Receives mono 22.05 kHz samples.
let modulesPromise = null;

function loadModules(urls) {
  if (!modulesPromise) {
    modulesPromise = Promise.all([import(urls.tfModule), import(urls.basicPitchModule)]).then(async ([tf, bp]) => {
      try {
        await tf.setBackend("webgl");
      } catch (_error) {
        await tf.setBackend("cpu");
      }
      await tf.ready();
      return { tf, bp, model: new bp.BasicPitch(urls.basicPitchModel) };
    });
  }
  return modulesPromise;
}

self.onmessage = async (event) => {
  const { samples, urls, options } = event.data;
  try {
    self.postMessage({ type: "stage", stage: "model" });
    const { tf, bp, model } = await loadModules(urls);
    self.postMessage({ type: "stage", stage: "listen", backend: tf.getBackend() });

    const frames = [];
    const onsets = [];
    const contours = [];
    await model.evaluateModel(
      samples,
      (f, o, c) => {
        frames.push(...f);
        onsets.push(...o);
        contours.push(...c);
      },
      (percent) => self.postMessage({ type: "progress", percent })
    );

    self.postMessage({ type: "stage", stage: "notes" });
    const events = bp.noteFramesToTime(
      bp.addPitchBendsToNoteEvents(
        contours,
        bp.outputToNotesPoly(frames, onsets, options.onsetThreshold, options.frameThreshold, options.minNoteFrames, true, 4186, 27.5, true)
      )
    );

    const notes = events.map((n) => ({
      t: n.startTimeSeconds,
      d: n.durationSeconds,
      midi: n.pitchMidi,
      v: Math.round(40 + Math.min(1, n.amplitude) * 87),
      a: n.amplitude,
    }));
    self.postMessage({ type: "done", notes });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};
