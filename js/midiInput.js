// Web MIDI keyboard support (Chrome, Edge, Opera, Firefox; not Safari).
export function createMidiInput({ onNoteOn, onNoteOff, onSustain, onDevicesChange }) {
  let access = null;

  function bindInputs() {
    const names = [];
    for (const input of access.inputs.values()) {
      names.push(input.name);
      input.onmidimessage = (event) => {
        const [status, data1, data2] = event.data;
        const command = status & 0xf0;
        if (command === 0x90 && data2 > 0) onNoteOn(data1, data2);
        else if (command === 0x80 || (command === 0x90 && data2 === 0)) onNoteOff(data1);
        else if (command === 0xb0 && data1 === 64) onSustain(data2 >= 64);
      };
    }
    onDevicesChange(names);
  }

  async function connect() {
    if (!navigator.requestMIDIAccess) {
      throw new Error("This browser doesn't support MIDI keyboards. Try Chrome or Edge.");
    }
    access = await navigator.requestMIDIAccess();
    access.onstatechange = bindInputs;
    bindInputs();
  }

  // Reconnect silently if the user already granted permission earlier.
  async function autoConnect() {
    try {
      if (!navigator.requestMIDIAccess || !navigator.permissions) return;
      const status = await navigator.permissions.query({ name: "midi" });
      if (status.state === "granted") await connect();
    } catch (_error) {
      // Permission API may not know "midi"; the user can connect manually.
    }
  }

  return { connect, autoConnect, supported: Boolean(navigator.requestMIDIAccess) };
}
