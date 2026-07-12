"""Testes da captura de correções (Fase 1 — semente do cache aprendido).

Só a lógica PURA (_correcoes_diff): quais campos de fato mudaram numa edição.
O wiring de banco (_registrar_correcoes/atualizar_bilhete) é casca fina e não-fatal.
"""
from repository import _correcoes_diff


def test_ignora_campos_iguais():
    antes = {"aposta": "ML", "stake": "100", "casa": "Bet365", "descricao": "x"}
    safe = {"aposta": "ML", "stake": "100"}
    assert _correcoes_diff(antes, safe) == []


def test_captura_mudanca_de_categoria():
    # o caso que importa pro cache: Outros ⚠️ corrigido para categoria real
    antes = {"aposta": "Outros ⚠️", "descricao": "Race 9 - Suécia"}
    safe = {"aposta": "Escanteios"}
    assert _correcoes_diff(antes, safe) == [("aposta", "Outros ⚠️", "Escanteios")]


def test_none_vs_vazio_nao_e_mudanca():
    antes = {"tipster": None}
    safe = {"tipster": ""}
    assert _correcoes_diff(antes, safe) == []


def test_varios_campos_so_os_alterados():
    antes = {"aposta": "A", "stake": "10", "odd": "2,0"}
    safe = {"aposta": "B", "stake": "10", "odd": "3,0"}
    mudados = {c for c, _a, _n in _correcoes_diff(antes, safe)}
    assert mudados == {"aposta", "odd"}
