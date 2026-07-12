"""Testes do modo cego (Fase 2 — casa sem manual extrai só com os masters globais).

build_system deve devolver os 6 masters + 1 bloco de casa QUANDO o CASA_*.md existe,
e só os 6 masters quando não existe (casa nova, desconhecida).
"""
from prompts import build_system


def test_casa_conhecida_inclui_manual():
    blocks = build_system("BET365")   # casas/CASA_BET365.md existe
    assert len(blocks) == 7           # 6 masters globais + 1 casa


def test_casa_desconhecida_modo_cego():
    blocks = build_system("OIOIOIBET_INEXISTENTE_123")
    assert len(blocks) == 6           # só os 6 masters — sem bloco de casa
    # o breakpoint de cache continua no último master global
    assert blocks[-1].get("cache_control") == {"type": "ephemeral"}
    assert all(b["type"] == "text" for b in blocks)
