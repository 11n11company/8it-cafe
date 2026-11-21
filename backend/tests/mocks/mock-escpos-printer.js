/**
 * Cafe Cloud POS - Simulated ESC/POS Wi-Fi Thermal Printer (TCP Port 9100)
 *
 * Implements a lightweight TCP server that emulates physical 80mm ESC/POS printers:
 * - Listens for incoming raw socket connections
 * - Buffers binary byte stream
 * - Decodes standard ESC/POS commands (ESC @, ESC a, ESC E, GS !, GS V cut)
 * - Extracts clean text lines for automated test verification
 * - Exposes captured print jobs, connection count, and clear methods
 */

const net = require('net');

class MockEscPosPrinter {
  constructor(options = {}) {
    this.name = options.name || 'Mock Thermal Printer';
    this.port = options.port || 9100;
    this.host = options.host || '127.0.0.1';
    this.server = null;
    this.capturedPrints = [];
    this.connectionCount = 0;
    this.isListening = false;
    this.mode = options.mode || 'normal'; // 'normal', 'paperOut', 'coverOpen', 'offline', 'unsupportedStatus', 'disconnectOnWrite'
  }

  setMode(mode) {
    this.mode = mode;
  }

  /**
   * Start TCP socket listener
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.connectionCount++;
        const chunks = [];

        socket.on('data', (chunk) => {
          // 1. Simulate network disconnect / socket drop mid-write
          if (this.mode === 'disconnectOnWrite') {
            socket.destroy(new Error('Simulated network disconnect during transmission'));
            return;
          }

          // 2. Handle ESC/POS DLE EOT n bidirectional status queries (0x10, 0x04, n)
          if (chunk.length === 3 && chunk[0] === 0x10 && chunk[1] === 0x04) {
            const n = chunk[2];
            // If printer does not support status reporting, ignore and do not reply
            if (this.mode === 'unsupportedStatus') {
              return;
            }

            let statusByte = 0x00;
            if (this.mode === 'paperOut') {
              if (n === 1) statusByte = 0x08; // offline
              else if (n === 2) statusByte = 0x20; // bit 5 = paper out
              else if (n === 4) statusByte = 0x60; // bits 5 & 6 = paper roll end
            } else if (this.mode === 'coverOpen') {
              if (n === 1) statusByte = 0x08; // offline
              else if (n === 2) statusByte = 0x04; // bit 2 = cover open
              else if (n === 3) statusByte = 0x04; // recoverable error
            } else if (this.mode === 'offline') {
              if (n === 1) statusByte = 0x08; // bit 3 = offline
            } else {
              // Normal: all bits clear
              statusByte = 0x00;
            }

            socket.write(Buffer.from([statusByte]));
            return;
          }

          chunks.push(chunk);
        });

        socket.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const parsedTicket = this.parseEscPosBuffer(rawBuffer);
          this.capturedPrints.push({
            timestamp: new Date().toISOString(),
            rawBytes: rawBuffer,
            sizeBytes: rawBuffer.length,
            ...parsedTicket
          });
        });

        socket.on('error', (err) => {
          // Socket errors handled cleanly
        });
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        this.isListening = true;
        resolve({
          name: this.name,
          host: this.host,
          port: this.port
        });
      });
    });
  }

  /**
   * Parse ESC/POS binary stream into clean text lines and detected control codes
   */
  parseEscPosBuffer(buffer) {
    let text = '';
    let hasCutCommand = false;
    let hasInitCommand = false;
    let i = 0;

    while (i < buffer.length) {
      const b0 = buffer[i];

      // ESC @ (Initialize: 0x1B 0x40)
      if (b0 === 0x1b && buffer[i + 1] === 0x40) {
        hasInitCommand = true;
        i += 2;
        continue;
      }

      // ESC a n (Alignment: 0x1B 0x61 n)
      if (b0 === 0x1b && buffer[i + 1] === 0x61) {
        i += 3;
        continue;
      }

      // ESC E n (Bold: 0x1B 0x45 n)
      if (b0 === 0x1b && buffer[i + 1] === 0x45) {
        i += 3;
        continue;
      }

      // GS ! n (Font size: 0x1D 0x21 n)
      if (b0 === 0x1d && buffer[i + 1] === 0x21) {
        i += 3;
        continue;
      }

      // GS V m (Cut: 0x1D 0x56 m [n])
      if (b0 === 0x1d && buffer[i + 1] === 0x56) {
        hasCutCommand = true;
        i += 3;
        if (i < buffer.length && buffer[i] === 0x00) i++;
        continue;
      }

      // Printable character or newline
      if (b0 === 0x0a) {
        text += '\n';
      } else if (b0 >= 0x20 && b0 <= 0x7e) {
        text += String.fromCharCode(b0);
      }

      i++;
    }

    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    return {
      rawText: text,
      lines,
      hasCutCommand,
      hasInitCommand
    };
  }

  /**
   * Get all captured print tickets
   */
  getCapturedPrints() {
    return [...this.capturedPrints];
  }

  /**
   * Get latest captured print ticket
   */
  getLastPrint() {
    return this.capturedPrints[this.capturedPrints.length - 1] || null;
  }

  /**
   * Reset prints history
   */
  clear() {
    this.capturedPrints = [];
  }

  /**
   * Stop the mock server
   */
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.isListening = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = {
  MockEscPosPrinter
};
