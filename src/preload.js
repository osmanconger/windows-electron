const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  onRecordingError: (callback) => ipcRenderer.on('recording-error', (event, error) => callback(error)),
  sendMicrophoneData: (data) => ipcRenderer.send('microphone-data', data)
});
