// Fake Web MIDI keyboard and a switch to make IndexedDB writes fail.
(function () {
  const input = { id: 'fake', onmidimessage: null };
  window.__midiSend = (st, note, vel) => input.onmidimessage && input.onmidimessage({ data: [st, note, vel] });
  navigator.requestMIDIAccess = async () => ({ inputs: new Map([['fake', input]]), onstatechange: null });
  const realPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () {
    if (window.__failPut) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return realPut.apply(this, arguments);
  };
})();
