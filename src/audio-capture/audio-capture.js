const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');

class AudioCapture extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      sampleRate: options.sampleRate || 48000,
      chunkDuration: options.chunkDuration || null,
      binaryPath: options.binaryPath || path.join(__dirname, 'windows-audio-capture.exe'),
      ...options
    };

    this.process = null;
    this.isRunning = false;
  }

  buildArguments() {
    const args = ['--sample-rate', this.options.sampleRate.toString()];

    if (this.options.chunkDuration !== null) {
      args.push('--chunk-duration', this.options.chunkDuration.toString());
    }

    return args;
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        return reject(new Error('AudioCapture is already running'));
      }

      const args = this.buildArguments();

      try {
        console.log('Spawning audio capture process:');
        console.log('  Binary:', this.options.binaryPath);
        console.log('  Args:', args);

        this.process = spawn(this.options.binaryPath, args, {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        this.isRunning = true;

        this.process.stdout.on('data', (chunk) => {
          console.log('Raw stdout data received:', chunk.length, 'bytes');
          this.emit('data', chunk);
        });

        this.process.stderr.on('data', (data) => {
          const message = data.toString().trim();
          console.log('Stderr output:', message);

          try {
            const parsed = JSON.parse(message);
            this.emit('log', parsed);

            if (parsed.level === 'error') {
              this.emit('error', new Error(parsed.message || message));
            }
          } catch (e) {
            this.emit('log', { level: 'info', message });
          }
        });

        this.process.on('error', (error) => {
          console.error('Process error:', error);
          this.isRunning = false;
          this.emit('error', error);
          reject(error);
        });

        this.process.on('exit', (code, signal) => {
          console.log('Process exited with code:', code, 'signal:', signal);
          this.isRunning = false;
          this.process = null;

          const exitInfo = { code, signal };
          this.emit('exit', exitInfo);

          if (code !== 0 && code !== null) {
            const error = new Error(`Process exited with code ${code}`);
            error.exitInfo = exitInfo;
            this.emit('error', error);
          }
        });

        this.process.on('spawn', () => {
          console.log('Process spawned successfully, PID:', this.process.pid);
          this.emit('start');
          resolve();
        });

      } catch (error) {
        this.isRunning = false;
        reject(error);
      }
    });
  }

  stop(timeout = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.isRunning) {
        return resolve();
      }

      const killTimeout = setTimeout(() => {
        if (this.process && this.isRunning) {
          this.process.kill('SIGKILL');
          reject(new Error('Process did not exit gracefully, force killed'));
        }
      }, timeout);

      this.process.once('exit', () => {
        clearTimeout(killTimeout);
        this.emit('stop');
        resolve();
      });

      this.process.kill('SIGTERM');
    });
  }

  getSampleRate() {
    return this.options.sampleRate;
  }

  getChunkDuration() {
    return this.options.chunkDuration;
  }

  isActive() {
    return this.isRunning;
  }
}

module.exports = AudioCapture;
