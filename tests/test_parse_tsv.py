"""Testes de `repository.parse_tsv` — a fronteira de entrada do /salvar (#180 auditoria turbo).

`parse_tsv` converte o bloco TSV da IA em dicts. Não tinha teste e descarta linha
malformada em silêncio; estes testes travam o contrato (o que passa, o que é dropado)
para uma regressão nunca mudá-lo sem querer. Função pura — roda na suíte normal.
"""
import repository as R

TAB = "\t"


def _linha(*campos):
    return TAB.join(campos)


def test_linha_bem_formada_10_colunas():
    tsv = _linha("01/07/2026", "Futebol", "Peixe", "Betano", "Feca",
                 "ML", "Time A vs Time B", "100,00", "1,90", "W")
    rows = R.parse_tsv(tsv)
    assert len(rows) == 1
    r = rows[0]
    assert r["data"] == "01/07/2026"
    assert r["esporte"] == "Futebol"
    assert r["stake"] == "100,00"
    assert r["odd"] == "1,90"
    assert r["resultado"] == "W"
    assert "codigo_bilhete" not in r          # sem 11ª coluna → sem código


def test_11a_coluna_vira_codigo_bilhete():
    tsv = _linha("01/07/2026", "Futebol", "", "Betano", "Feca",
                 "ML", "Desc", "50,00", "2,00", "L", "BET12345")
    rows = R.parse_tsv(tsv)
    assert len(rows) == 1
    assert rows[0]["codigo_bilhete"] == "BET12345"


def test_11a_coluna_vazia_nao_vira_codigo():
    tsv = _linha("01/07/2026", "Futebol", "", "Betano", "Feca",
                 "ML", "Desc", "50,00", "2,00", "L", "   ")
    assert "codigo_bilhete" not in R.parse_tsv(tsv)[0]


def test_linha_malformada_menos_de_10_colunas_e_descartada():
    # Comportamento atual: < 10 colunas → linha dropada em silêncio (documentado).
    boa = _linha("01/07/2026", "Futebol", "", "Betano", "Feca",
                 "ML", "Desc", "50,00", "2,00", "W")
    ruim = _linha("01/07/2026", "Futebol", "faltando", "colunas")   # só 4
    rows = R.parse_tsv(ruim + "\n" + boa)
    assert len(rows) == 1                      # só a boa sobrevive
    assert rows[0]["resultado"] == "W"


def test_linhas_vazias_e_cabecalho_sao_puladas():
    header = _linha("Data", "Esporte", "Tipster", "Casa", "Parceiro",
                    "Aposta", "Descrição", "Stake", "Odd", "Resultado")
    boa = _linha("01/07/2026", "Futebol", "", "Betano", "Feca",
                 "ML", "Desc", "50,00", "2,00", "V")
    rows = R.parse_tsv(header + "\n\n" + boa + "\n   \n")
    assert len(rows) == 1
    assert rows[0]["resultado"] == "V"


def test_bloco_vazio_devolve_lista_vazia():
    assert R.parse_tsv("") == []
    assert R.parse_tsv("\n\n   \n") == []
