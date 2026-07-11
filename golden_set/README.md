# golden_set — bilhetes de validação

Pasta destinada aos **bilhetes reais + TSV esperado** usados para validar a extração
(conforme a estrutura descrita no `../CLAUDE.md`).

**Estado atual:** ainda **não populada**. A validação hoje roda pela suíte `../tests/`
(65 testes: fórmulas, dedup, ordem Bet365, Betfair) + `tools/audit_casas.py` +
`scripts/tokens/check-tokens.mjs`.

**Como popular (quando quiser):** para cada bilhete real, salvar em `bilhetes/` o print/texto
de origem + o TSV esperado (10 colunas, TAB, decimal vírgula — ver `../global/MASTER_OUTPUT_2026.md`),
para servir de caso de regressão ponta-a-ponta.

> Este README existe para dar propósito à pasta e evitar que ela pareça órfã. Remova-o quando os
> primeiros goldens forem adicionados.
