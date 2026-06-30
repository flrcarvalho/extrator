// ── _lib.mjs — base compartilhada do pipeline de tokens ─────────────────────
// FONTE ÚNICA: ../pack/tokens/tokens.css (fora do repo, casa da marca).
// As cópias do app são GERADAS a partir dele. build e check usam ESTE módulo
// para nunca duplicarem a regra de transformação (a mesma causa-raiz que o
// pipeline combate: regra copiada sai de sincronia).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/tokens → repo (Planilhador)
export const REPO_ROOT = resolve(__dirname, '..', '..');
// canônico mora no pack, irmão do repo
export const CANONICAL = resolve(REPO_ROOT, '..', 'pack', 'tokens', 'tokens.css');

// cópias geradas (caminhos relativos ao repo)
export const TARGETS = [
  { rel: 'app/static/tokens.css',                    label: 'Planilhador' },
  { rel: 'app/static/dash/assets/css/tokens.css',    label: 'Dashboard'   },
].map(t => ({ ...t, path: resolve(REPO_ROOT, t.rel) }));

export const GERADO_BANNER =
`/* ============================================================
   FDC CAPITAL — Design Tokens · CÓPIA GERADA — NÃO EDITAR
   Gerado de pack/tokens/tokens.css por scripts/tokens/build-tokens.mjs.
   Edite o canônico e rode: node scripts/tokens/build-tokens.mjs
   ============================================================ */
`;

export function canonicalExists() { return existsSync(CANONICAL); }

// Corpo do canônico = tudo APÓS o banner de comentário inicial.
export function canonicalBody() {
  const src = readFileSync(CANONICAL, 'utf8');
  const end = src.indexOf('*/');
  const body = end === -1 ? src : src.slice(end + 2);
  return body.replace(/^\s*\n/, '');   // remove a linha em branco que sobra após o banner
}

// Conteúdo esperado de uma cópia gerada = banner GERADO + corpo do canônico.
export function expectedContent() {
  return GERADO_BANNER + '\n' + canonicalBody();
}
