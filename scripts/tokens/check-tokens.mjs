// ── check-tokens.mjs — guardrail do pipeline de tokens ──────────────────────
// Uso: node scripts/tokens/check-tokens.mjs
// (a) DRIFT  (BLOQUEANTE): as cópias do app batem com o canônico gerado?
//     Se alguém editou uma cópia à mão (ou esqueceu de rodar o build) → falha.
// (b) PALETA: as cores BANIDAS (cyan / azul off-paleta / Tailwind) são SEMPRE
//     bloqueantes — foram erradicadas na Fase 2 e não podem voltar. O total de
//     cores literais é só informativo (WARN); reduzi-lo é trabalho de polimento.
// Skip gracioso se o canônico (../pack) não existir — não trava clones sem o pack.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { REPO_ROOT, TARGETS, CANONICAL, canonicalExists, expectedContent } from './_lib.mjs';

let blocking = 0;

// ── (a) DRIFT ───────────────────────────────────────────────────────────────
if (!canonicalExists()) {
  console.warn(`⚠ canônico ausente (${CANONICAL}) — pulo o check de drift (clone sem pack/).`);
} else {
  const expected = expectedContent();
  for (const t of TARGETS) {
    const actual = readFileSync(t.path, 'utf8').replace(/\r\n/g, '\n');
    if (actual !== expected.replace(/\r\n/g, '\n')) {
      console.error(`✗ DRIFT  ${t.rel} difere do canônico. Rode: node scripts/tokens/build-tokens.mjs`);
      blocking++;
    } else {
      console.log(`✓ sync   ${t.rel}`);
    }
  }
}

// ── (b) PALETA ───────────────────────────────────────────────────────────────
const OFF_BRAND = new Set(['#34d399','#fbbf24','#60a5fa','#fb923c','#00e5ff','#1e90ff']);
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const SCAN_ROOT = resolve(REPO_ROOT, 'app/static');
const SKIP = new Set(TARGETS.map(t => resolve(t.path)));   // não conta os próprios tokens.css

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(css|js|html)$/.test(name) && !SKIP.has(resolve(p))) out.push(p);
  }
  return out;
}

let total = 0;
const uniq = new Map();        // cor → ocorrências
const offHits = [];            // {file, color}
for (const f of walk(SCAN_ROOT)) {
  const txt = readFileSync(f, 'utf8');
  const rel = f.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
  for (const m of txt.matchAll(COLOR_RE)) {
    const c = m[0].toLowerCase();
    total++;
    uniq.set(c, (uniq.get(c) || 0) + 1);
    if (OFF_BRAND.has(c.replace(/\s/g, '').replace(/^#([0-9a-f])\1\1$/, '#$1$1$1$1$1$1')) || OFF_BRAND.has(c))
      offHits.push({ rel, c });
  }
}

console.log(`\n── Paleta (app/static, fora dos tokens.css) ──`);
console.log(`  ${total} cores literais · ${uniq.size} valores únicos`);
if (offHits.length) {
  console.error(`  ✗ ${offHits.length} cor(es) BANIDA(S) (cyan / azul off / Tailwind):`);
  const by = {};
  for (const h of offHits) (by[h.c] = by[h.c] || new Set()).add(h.rel);
  for (const [c, files] of Object.entries(by))
    console.error(`     ${c}  →  ${[...files].join(', ')}`);
  blocking++;
} else {
  console.log(`  ✓ nenhuma cor banida`);
}

// ── veredito ─────────────────────────────────────────────────────────────────
if (blocking) { console.error(`\n✗ check-tokens FALHOU (${blocking}).`); process.exit(1); }
console.log(`\n✓ check-tokens OK.`);
