
let isRecording = false;
const recordBtn = document.getElementById('recordBtn');

// Microphone capture state
let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let isCapturing = false;
let onDataCallback = null;

async function startRecording() {
  console.log('Renderer: Starting recording');
  recordBtn.disabled = true;

  try {
    const result = await window.electronAPI.startRecording();

    if (result.success) {
      isRecording = true;
      recordBtn.textContent = 'Stop';
      console.log('System audio recording started');

      await startMicrophone(16000);
      console.log('Microphone recording started');
    } else {
      console.error('Failed to start recording:', result.error);
      alert(`Failed to start recording: ${result.error}`);
    }
  } catch (error) {
    console.error('Error starting recording:', error);
    alert(`Error: ${error.message}`);
  } finally {
    recordBtn.disabled = false;
  }
}

async function stopRecording() {
  console.log('Renderer: Stopping recording');
  recordBtn.disabled = true;

  try {
    // Stop microphone capture
    stopMicrophone();
    console.log('Microphone recording stopped');

    const result = await window.electronAPI.stopRecording();

    if (result.success) {
      isRecording = false;
      recordBtn.textContent = 'Record';

      if (result.realtimeMixedPath) {
        console.log('Mixed recording saved:', result.realtimeMixedPath);
        alert(`Mixed recording saved to:\n${result.realtimeMixedPath}`);
      } else {
        console.log('No audio data captured');
        alert('No audio data was captured');
      }
    } else {
      console.error('Failed to stop recording:', result.error);
      alert(`Failed to stop recording: ${result.error}`);
    }
  } catch (error) {
    console.error('Error stopping recording:', error);
    alert(`Error: ${error.message}`);
  } finally {
    recordBtn.disabled = false;
  }
}

// Handle recording errors from main process
window.electronAPI.onRecordingError((error) => {
  console.error('Recording error from main:', error);
  isRecording = false;
  recordBtn.textContent = 'Record';
  recordBtn.disabled = false;
  alert(`Recording error: ${error}`);
});

recordBtn.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});







// Microphone helper functions

async function startMicrophone(sampleRate = 16000) {
  if (isCapturing) {
    throw new Error('Already capturing microphone');
  }

  console.log('Attempting to capture microphone data');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: sampleRate
      }
    });

    audioContext = new AudioContext({ sampleRate: sampleRate });
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);

    processorNode.onaudioprocess = (event) => {
      if (!isCapturing) return;

      const inputData = event.inputBuffer.getChannelData(0);
      const pcmData = convertFloat32ToInt16(inputData);

      window.electronAPI.sendMicrophoneData(pcmData.buffer);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    isCapturing = true;
    console.log('Microphone capture started at', sampleRate, 'Hz');
  } catch (error) {
    console.error('Failed to start microphone capture:', error);
    throw error;
  }
}

function stopMicrophone() {
  if (!isCapturing) return;

  isCapturing = false;

  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  console.log('Microphone capture stopped');
}

function convertFloat32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  return int16Array;
}

