// ── build-tokens.mjs — gera as cópias do app a partir do canônico ───────────
// Uso: node scripts/tokens/build-tokens.mjs
// Lê ../pack/tokens/tokens.css (FONTE ÚNICA) e escreve cópias idênticas
// (com banner GERADO) em app/static/tokens.css e
// app/static/dash/assets/css/tokens.css.
import { writeFileSync } from 'node:fs';
import { CANONICAL, TARGETS, canonicalExists, expectedContent } from './_lib.mjs';

if (!canonicalExists()) {
  console.error(`✗ Canônico não encontrado: ${CANONICAL}`);
  console.error('  (o pack/ é a casa da marca, irmão do repo Planilhador)');
  process.exit(1);
}

const content = expectedContent();
let n = 0;
for (const t of TARGETS) {
  writeFileSync(t.path, content, 'utf8');
  console.log(`✓ gerado  ${t.rel}  (${t.label})`);
  n++;
}
console.log(`\n${n} cópia(s) geradas de pack/tokens/tokens.css.`);
