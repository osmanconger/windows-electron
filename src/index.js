const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const AudioCapture = require('./audio-capture/audio-capture');
const { AssemblyAI } = require('assemblyai');

let mainWindow;
let isRecording = false;
let audioCapture = null;
let realtimeMixer = null;
let realtimeMixedStream = null;
let realtimeMixedFilePath = null;
let transcriber;
let isTranscriberReady = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 650,
    height: 600,
    title: 'Mic & Speaker Streamer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('src/index.html');
  mainWindow.webContents.openDevTools();
}

// Initialize AssemblyAI transcriber
function initTranscriber() {
  console.log('Initializing AssemblyAI transcriber...');

  const client = new AssemblyAI({
    apiKey: "",
  });

  transcriber = client.streaming.transcriber({
    sampleRate: 16000,
    formatTurns: true,
    encoding: 'pcm_s16le',
  });

  console.log('AssemblyAI transcriber initialized');
}

// Handle start recording
ipcMain.handle('start-recording', async () => {
  console.log('Main: Starting recording');

  if (isRecording) {
    return { success: false, error: 'Already recording' };
  }

  try {
    isRecording = true;
    isTranscriberReady = false;

    // Initialize real-time mixer
    realtimeMixer = new RealTimeAudioMixer(16000);

    // Create file stream for real-time mixed audio
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `realtime-mixed-${timestamp}.pcm`;
    realtimeMixedFilePath = path.join(os.homedir(), 'Downloads', filename);
    realtimeMixedStream = fs.createWriteStream(realtimeMixedFilePath);

    console.log(`Real-time mixed audio will be saved to: ${realtimeMixedFilePath}`);

    // Set up transcriber event listeners BEFORE connecting
    transcriber.on('open', ({ id }) => {
      console.log(`AssemblyAI session opened with ID: ${id}`);
      console.log('Listening for system audio...\n');
      isTranscriberReady = true;
    });

    transcriber.on('error', (error) => {
      console.error('AssemblyAI Error:', error);
    });

    transcriber.on('close', (code, reason) => {
      console.log(`AssemblyAI session closed: ${code} - ${reason}`);
      isTranscriberReady = false;
    });

    transcriber.on('turn', (turn) => {
      if (!turn.transcript || turn.transcript.trim() === '') {
        return;
      }

      // Show partial transcripts in real-time
      if (!turn.end_of_turn || !turn.turn_is_formatted) {
        // Clear line and show partial transcript
        console.log(`\r${turn.transcript}`);
      } else {
        // Show final formatted transcript
        console.log(`\r${' '.repeat(100)}\r`); // Clear line
        console.log(`${turn.transcript}`);
      }
    });

    // Connect to AssemblyAI
    console.log('Connecting to AssemblyAI...');
    await transcriber.connect();

    // Listen for mixed audio data and write to file in real-time
    realtimeMixer.on('mixed-data', (mixedChunk) => {
      realtimeMixedStream.write(mixedChunk);

      // Only send to transcriber if connection is ready
      if (isTranscriberReady) {
        transcriber.sendAudio(mixedChunk);
      }
    });

    console.log('Start executable');

    audioCapture = new AudioCapture({
      sampleRate: 16000,
      chunkDuration: 200
    });

    audioCapture.on('data', (chunk) => {
      if (isRecording) {
        console.log(`Received system audio chunk: ${chunk.length} bytes`);

        // Convert float32 stereo to int16 mono
        const convertedChunk = convertSystemAudioToInt16Mono(chunk);

        // Feed to real-time mixer
        realtimeMixer.addSystemAudio(convertedChunk);
      }
    });

    audioCapture.on('error', (error) => {
      console.error('Recording error:', error);
      isRecording = false;
      mainWindow.webContents.send('recording-error', error.message);
    });

    audioCapture.on('log', (log) => {
      console.log('AudioCapture log:', log);
    });

    await audioCapture.start();

    console.log('Recording stream created successfully');

    return { success: true };
  } catch (error) {
    console.error('Failed to start recording:', error);
    isRecording = false;
    audioCapture = null;
    return { success: false, error: error.message };
  }
});

// Handle microphone data from renderer
ipcMain.on('microphone-data', (event, data) => {
  if (isRecording) {
    const micBuffer = Buffer.from(data);
    // Feed to real-time mixer
    realtimeMixer.addMicrophoneAudio(micBuffer);
  }
});

// Handle stop recording
ipcMain.handle('stop-recording', async () => {
  console.log('Main: Stopping recording');

  if (!isRecording) {
    return { success: false, error: 'Not recording' };
  }

  try {
    isRecording = false;

    if (audioCapture) {
      await audioCapture.stop();
      audioCapture = null;
    }

    const result = { success: true };

    // Flush any remaining audio in mixer buffers
    if (realtimeMixer) {
      realtimeMixer.flush();
      realtimeMixer.reset();
    }

    // Close transcriber connection
    if (isTranscriberReady) {
      console.log('Closing AssemblyAI connection...');
      await transcriber.close();
      isTranscriberReady = false;
    }

    // Close real-time mixed stream
    if (realtimeMixedStream) {
      await new Promise((resolve) => {
        realtimeMixedStream.end(() => {
          console.log(`Real-time mixed audio saved to: ${realtimeMixedFilePath}`);
          resolve();
        });
      });
      result.realtimeMixedPath = realtimeMixedFilePath;
    }

    return result;
  } catch (error) {
    console.error('Failed to stop recording:', error);
    return { success: false, error: error.message };
  }
});

// Convert system audio from float32 stereo to int16 mono
function convertSystemAudioToInt16Mono(chunk) {
  // System audio is 32-bit float stereo (2 channels)
  const systemFloat32Stereo = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.length / 4);

  // Convert stereo to mono by averaging left and right channels
  const systemFloat32Mono = new Float32Array(systemFloat32Stereo.length / 2);
  for (let i = 0; i < systemFloat32Mono.length; i++) {
    systemFloat32Mono[i] = (systemFloat32Stereo[i * 2] + systemFloat32Stereo[i * 2 + 1]) / 2;
  }

  // Convert float32 to int16
  const systemSamples = new Int16Array(systemFloat32Mono.length);
  for (let i = 0; i < systemFloat32Mono.length; i++) {
    const clamped = Math.max(-1, Math.min(1, systemFloat32Mono[i]));
    systemSamples[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }

  return Buffer.from(systemSamples.buffer);
}

app.whenReady().then(() => {
  initTranscriber();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit
app.on('before-quit', async () => {
  if (isRecording && audioCapture) {
    try {
      await audioCapture.stop();
      audioCapture = null;
    } catch (error) {
      console.error('Error stopping audio capture on quit:', error);
    }
  }
  if (isTranscriberReady) {
    try {
      await transcriber.close();
    } catch (error) {
      console.error('Error closing transcriber on quit:', error);
    }
  }
});


class RealTimeAudioMixer extends EventEmitter {
  constructor(sampleRate = 16000) {
    super();
    this.sampleRate = sampleRate;
    this.systemBuffer = Buffer.alloc(0);
    this.micBuffer = Buffer.alloc(0);
    this.chunkSize = Math.floor(sampleRate * 0.2) * 2; // 100ms chunks in bytes (16-bit = 2 bytes per sample)
  }

  addSystemAudio(chunk) {
    this.systemBuffer = Buffer.concat([this.systemBuffer, chunk]);
    this.tryMix();
  }

  addMicrophoneAudio(chunk) {
    this.micBuffer = Buffer.concat([this.micBuffer, chunk]);
    this.tryMix();
  }

  tryMix() {
    // Mix and emit whenever we have at least chunkSize bytes from both sources
    while (this.systemBuffer.length >= this.chunkSize && this.micBuffer.length >= this.chunkSize) {
      const systemChunk = this.systemBuffer.slice(0, this.chunkSize);
      const micChunk = this.micBuffer.slice(0, this.chunkSize);

      // Remove processed chunks from buffers
      this.systemBuffer = this.systemBuffer.slice(this.chunkSize);
      this.micBuffer = this.micBuffer.slice(this.chunkSize);

      // Mix the chunks
      const mixedChunk = this.mixChunks(systemChunk, micChunk);

      // Emit the mixed audio for real-time processing (e.g., transcription)
      this.emit('mixed-data', mixedChunk);
    }
  }

  mixChunks(systemChunk, micChunk) {
    const systemSamples = new Int16Array(systemChunk.buffer, systemChunk.byteOffset, systemChunk.length / 2);
    const micSamples = new Int16Array(micChunk.buffer, micChunk.byteOffset, micChunk.length / 2);

    const mixedSamples = new Int16Array(systemSamples.length);

    for (let i = 0; i < systemSamples.length; i++) {
      // Mix by averaging to prevent clipping
      mixedSamples[i] = Math.round((systemSamples[i] + micSamples[i]) / 2);
    }

    return Buffer.from(mixedSamples.buffer);
  }

  flush() {
    // Mix any remaining audio in buffers when recording stops
    const minLength = Math.min(this.systemBuffer.length, this.micBuffer.length);

    if (minLength > 0) {
      const systemChunk = this.systemBuffer.slice(0, minLength);
      const micChunk = this.micBuffer.slice(0, minLength);

      const mixedChunk = this.mixChunks(systemChunk, micChunk);
      this.emit('mixed-data', mixedChunk);
    }

    // Clear buffers
    this.systemBuffer = Buffer.alloc(0);
    this.micBuffer = Buffer.alloc(0);
  }

  reset() {
    this.systemBuffer = Buffer.alloc(0);
    this.micBuffer = Buffer.alloc(0);
    this.removeAllListeners();
  }
}
