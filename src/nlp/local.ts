import { spawn } from 'node:child_process';
import type { ScoredItem, Scorer } from './types.js';

/* The local model path: a Python subprocess, spoken to over stdin/stdout.
 *
 * WHY NOT transformers.js. It needs ONNX builds, and the models worth using
 * here do not have one - cardiffnlp/twitter-xlm-roberta-base-sentiment is
 * PyTorch only, and so are the Afro-XLMR family. Converting them ourselves
 * means owning the conversion. Python talks to the real weights directly.
 *
 * WHY A SUBPROCESS AND NOT A SERVICE. Two reasons, and the second is the
 * important one. It keeps the Node app at a single runtime dependency, and
 * the text never touches a socket: it goes down a pipe to a process on this
 * machine and dies there. Compare AnthropicScorer, which sends it over the
 * wire - that difference should be visible in the code, because it is the
 * difference between listening to people locally and shipping what they
 * wrote to a third party.
 *
 * A NOTE ON LANGUAGE. The default model was fine-tuned on eight languages,
 * none of them South African. XLM-R has isiZulu, Sesotho, Setswana, Xhosa and
 * Afrikaans in its pretraining, so it is not blind to them, but it has not
 * been taught sentiment in them. Expect it to be weakest exactly where the
 * campaign most needs it. Fine-tuning on local data is the real fix; until
 * then, read non-English wards as under-measured, not as quiet.
 */

export interface LocalScorerOptions {
  /** Any Hugging Face sentiment model. Overridden by VENOM_NLP_MODEL. */
  model?: string;
  python?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

const DEFAULT_MODEL = 'cardiffnlp/twitter-xlm-roberta-base-sentiment';

export class LocalModelScorer implements Scorer {
  readonly name: string;
  private readonly model: string;
  private readonly python: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;

  constructor(options: LocalScorerOptions = {}) {
    this.model = options.model ?? process.env['VENOM_NLP_MODEL'] ?? DEFAULT_MODEL;
    this.python = options.python ?? process.env['VENOM_PYTHON'] ?? 'python3';
    this.scriptPath = options.scriptPath ?? 'scripts/score.py';
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.name = `local:${this.model}`;
  }

  async score(texts: string[]): Promise<ScoredItem[]> {
    if (texts.length === 0) return [];

    const child = spawn(this.python, [this.scriptPath, '--model', this.model], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; });
    child.stderr.on('data', (d: string) => { err += d; });

    // One JSON object per line, so a long batch streams instead of building
    // one enormous document in memory on either side.
    for (const text of texts) child.stdin.write(`${JSON.stringify({ text })}\n`);
    child.stdin.end();

    const code: number = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (c) => resolve(c ?? -1));
    });
    clearTimeout(timer);

    if (code !== 0) {
      throw new Error(
        `scorer exited ${code}. Is ${this.python} present with transformers installed? ${err.trim()}`);
    }

    const lines = out.split('\n').filter((l) => l.trim() !== '');
    if (lines.length !== texts.length) {
      // A silent length mismatch would misattribute every score after the gap
      // to the wrong item, which is worse than failing.
      throw new Error(`scorer returned ${lines.length} verdicts for ${texts.length} items`);
    }
    return lines.map((l) => JSON.parse(l) as ScoredItem);
  }
}
