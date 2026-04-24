/**
 * Terminal Channel for NanoClaw
 * Allows interacting with the orchestrator agent via stdin/stdout.
 * Uses a virtual JID "terminal:main" and registers as a NanoClaw channel.
 */
import readline from 'readline';

import { ASSISTANT_NAME } from './config.js';
import { registerChannel, ChannelOpts } from './channels/registry.js';
import { Channel, NewMessage } from './types.js';
import { logger } from './logger.js';

const TERMINAL_JID = 'terminal:main';
const CHANNEL_NAME = 'terminal';

function createTerminalChannel(opts: ChannelOpts): Channel | null {
  if (!process.stdin.isTTY && !process.env.NANOCLAW_TERMINAL) return null;

  let connected = false;
  let rl: readline.Interface | null = null;

  const channel: Channel = {
    name: CHANNEL_NAME,

    async connect() {
      connected = true;

      opts.onChatMetadata(
        TERMINAL_JID,
        new Date().toISOString(),
        'Terminal',
        CHANNEL_NAME,
        false,
      );

      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `\n\x1b[36m> \x1b[0m`,
      });

      console.log(
        `\n\x1b[1m╔══════════════════════════════════════════╗\x1b[0m`,
      );
      console.log(
        `\x1b[1m║  NanoClaw Terminal — @${ASSISTANT_NAME.padEnd(18)}║\x1b[0m`,
      );
      console.log(`\x1b[1m╚══════════════════════════════════════════╝\x1b[0m`);
      console.log(`  Type your message. Ctrl+C to exit.\n`);

      rl.prompt();

      rl.on('line', (line) => {
        const content = line.trim();
        if (!content) {
          rl!.prompt();
          return;
        }

        const msg: NewMessage = {
          id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          chat_jid: TERMINAL_JID,
          sender: 'user',
          sender_name: 'User',
          content,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        };

        opts.onMessage(TERMINAL_JID, msg);
      });

      rl.on('close', () => {
        connected = false;
      });

      logger.info('Terminal channel connected');
    },

    async sendMessage(_jid: string, text: string) {
      const cleaned = text
        .replace(/<internal>[\s\S]*?<\/internal>/g, '')
        .trim();
      if (!cleaned) return;

      console.log(`\n\x1b[33m${ASSISTANT_NAME}\x1b[0m: ${cleaned}`);
      rl?.prompt();
    },

    isConnected() {
      return connected;
    },

    ownsJid(jid: string) {
      return jid === TERMINAL_JID || jid.startsWith('terminal:');
    },

    async disconnect() {
      connected = false;
      rl?.close();
    },
  };

  return channel;
}

registerChannel(CHANNEL_NAME, createTerminalChannel);

export { TERMINAL_JID, CHANNEL_NAME };
