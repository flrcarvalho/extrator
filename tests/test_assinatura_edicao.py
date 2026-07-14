"""Assinatura recalculada na EDIÇÃO (lápis do editor de apostas).

Guarda o bug em que `atualizar_bilhete` gravava `aposta`/`descricao`/`stake`/`odd`/`data`
mas NÃO recalculava a `assinatura` — que inclui justamente esses campos. A linha ficava
com a assinatura do conteúdo ANTIGO, então uma re-extração do mesmo bilhete calculava uma
assinatura NOVA, não colidia, e o UPSERT duplicava em vez de atualizar.

Descoberto na sessão 145, ao corrigir a conta do Marlon (eBasket → Pontos): a correção
tinha de recalcular a assinatura na mão porque o app não o fazia.

conftest.py stuba asyncpg/database, então `import repository` funciona sem Postgres.
"""
import asyncio

import repository  # noqa: E402  (stubs vêm do conftest)

_A = repository._assinatura
_pos = repository._assinatura_pos_edicao


class _FakeConn:
    """Conn mínima: só o `fetchval` do NOT EXISTS de colisão de assinatura."""

    def __init__(self, ocupadas=()):
        # ocupadas: (dono, casa, parceiro, assinatura, id_da_linha_que_ocupa)
        self.ocupadas = list(ocupadas)

    async def fetchval(self, _sql, dono, casa, parceiro, sig, bilhete_id):
        return not any(
            o[:4] == (dono, casa, parceiro, sig) and o[4] != bilhete_id
            for o in self.ocupadas
        )


def _antes(**kw):
    base = dict(casa="Bet365", parceiro="marloncezar01 [Richard]", data="14/07/2026",
                aposta="Gols", descricao="Over 92.5 Totais do Jogo [OKC Thunder v NY Knicks]",
                stake="210,00", odd="1,83", codigo_bilhete=None)
    base.update(kw)
    base["assinatura"] = _A({**base, "codigo_bilhete": base["codigo_bilhete"] or ""})
    return base


def _run(antes, safe, conn=None, dono="Feca", bid=55046):
    return asyncio.run(_pos(conn or _FakeConn(), antes, safe, dono, bid))


# ── o hash não mudou → não mexe ────────────────────────────────────────────────

def test_colunas_fora_do_hash_nao_entram():
    # esporte/tipster/resultado NÃO entram na assinatura: o caller nem chama o helper.
    assert repository._SIG_COLS.isdisjoint({"esporte", "tipster", "resultado"})


def test_mesmo_valor_nao_gera_nova_assinatura():
    antes = _antes()
    assert _run(antes, {"aposta": "Gols"}) is None


# ── o hash mudou → grava a nova ────────────────────────────────────────────────

def test_editar_aposta_recalcula():
    antes = _antes()
    nova = _run(antes, {"aposta": "Pontos"})
    assert nova is not None and nova != antes["assinatura"]
    assert nova == _A({**antes, "aposta": "Pontos", "codigo_bilhete": ""})


def test_editar_descricao_recalcula():
    antes = _antes()
    desc = "Over 92.5 Pontos [OKC Thunder (BRAZEN) v NY Knicks (EQUALIZER)]"
    nova = _run(antes, {"descricao": desc})
    assert nova == _A({**antes, "descricao": desc, "codigo_bilhete": ""})


def test_editar_stake_e_odd_recalcula():
    antes = _antes()
    nova = _run(antes, {"stake": "300,00", "odd": "1,90"})
    assert nova == _A({**antes, "stake": "300,00", "odd": "1,90", "codigo_bilhete": ""})


# ── o teste que prova o gap fechado ────────────────────────────────────────────

def test_reextracao_do_bilhete_editado_agora_dedupa():
    """O motivo do fix: depois da edição, re-extrair o MESMO bilhete tem de colidir.

    Antes, a linha guardava a assinatura do conteúdo antigo; o upsert calculava a do
    conteúdo novo, não batia, e inseria uma segunda linha.
    """
    antes = _antes()
    correcao = {"aposta": "Pontos",
                "descricao": "Over 92.5 Pontos [OKC Thunder (BRAZEN) v NY Knicks (EQUALIZER)]"}
    gravada = _run(antes, correcao)

    # o que o upsert calcularia ao re-extrair o bilhete já corrigido
    linha_reextraida = {**{k: antes[k] for k in ("casa", "parceiro", "data", "stake", "odd")},
                        **correcao, "codigo_bilhete": ""}
    assert gravada == _A(linha_reextraida)          # colide → UPSERT atualiza
    assert antes["assinatura"] != _A(linha_reextraida)  # a antiga NÃO colidia (o bug)


# ── colisão ───────────────────────────────────────────────────────────────────

def test_colisao_sem_codigo_escala_counter():
    """Conteúdo final idêntico a OUTRA linha da conta → escala, como faz o upsert."""
    antes = _antes()
    alvo = {**antes, "aposta": "Pontos", "codigo_bilhete": ""}
    conn = _FakeConn([("Feca", antes["casa"], antes["parceiro"], _A(alvo), 99999)])
    nova = _run(antes, {"aposta": "Pontos"}, conn=conn)
    assert nova == _A(alvo, _counter=2)


def test_colisao_dupla_escala_ate_achar_livre():
    antes = _antes()
    alvo = {**antes, "aposta": "Pontos", "codigo_bilhete": ""}
    conn = _FakeConn([
        ("Feca", antes["casa"], antes["parceiro"], _A(alvo), 99998),
        ("Feca", antes["casa"], antes["parceiro"], _A(alvo, _counter=2), 99999),
    ])
    assert _run(antes, {"aposta": "Pontos"}, conn=conn) == _A(alvo, _counter=3)


def test_colisao_de_outra_conta_nao_conta():
    # mesma assinatura em OUTRO parceiro não colide (a unique é por dono+casa+parceiro).
    antes = _antes()
    alvo = {**antes, "aposta": "Pontos", "codigo_bilhete": ""}
    conn = _FakeConn([("Feca", antes["casa"], "outra-conta", _A(alvo), 99999)])
    assert _run(antes, {"aposta": "Pontos"}, conn=conn) == _A(alvo)


def test_propria_linha_nao_colide_consigo_mesma():
    antes = _antes()
    alvo = {**antes, "aposta": "Pontos", "codigo_bilhete": ""}
    # a própria linha (id 55046) ocupando o slot destino não pode bloquear
    conn = _FakeConn([("Feca", antes["casa"], antes["parceiro"], _A(alvo), 55046)])
    assert _run(antes, {"aposta": "Pontos"}, conn=conn) == _A(alvo)


# ── bilhete COM código ────────────────────────────────────────────────────────

def test_com_codigo_editar_descricao_nao_muda_o_hash():
    # hash por ID = ID|casa|parceiro|codigo → descrição não entra.
    antes = _antes(codigo_bilhete="O/1234567/89")
    assert _run(antes, {"descricao": "outra coisa"}) is None


def test_com_codigo_editar_parceiro_recalcula():
    antes = _antes(codigo_bilhete="O/1234567/89")
    nova = _run(antes, {"parceiro": "outra-conta"})
    assert nova == _A({**antes, "parceiro": "outra-conta"})


def test_com_codigo_em_colisao_mantem_a_atual():
    """Hash por ID ignora `_counter` → escalar não sai do lugar; mantém a atual."""
    antes = _antes(codigo_bilhete="O/1234567/89")
    alvo = {**antes, "parceiro": "outra-conta"}
    conn = _FakeConn([("Feca", antes["casa"], "outra-conta", _A(alvo), 99999)])
    assert _run(antes, {"parceiro": "outra-conta"}, conn=conn) is None
