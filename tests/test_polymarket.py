"""Polymarket — confiabilidade de saldo (#47) e cálculo de odd.

Guarda o fix: quando TODOS os RPCs públicos caem, `_rpc_balance` devolve None
(indisponível), NUNCA 0.0 (que mentiria "carteira vazia"). polymarket.py só usa
stdlib + httpx (sem asyncpg/database), então importa direto.
"""
import asyncio

import polymarket


class _Down:
    async def post(self, *a, **k):
        raise Exception("rpc down")


class _Ok:
    async def post(self, *a, **k):
        class R:
            def json(self_inner):
                return {"result": "0x" + format(5_000_000, "x").rjust(64, "0")}
        return R()


def test_rpc_balance_none_quando_todos_rpcs_caem():
    got = asyncio.run(polymarket._rpc_balance(_Down(), polymarket._PUSD, "0x" + "0" * 40))
    assert got is None   # indisponível — NÃO 0.0


def test_rpc_balance_valor_quando_responde():
    got = asyncio.run(polymarket._rpc_balance(_Ok(), polymarket._PUSD, "0x" + "0" * 40))
    assert got == 5.0    # 5_000_000 / 1e6 (6 casas)


def test_calc_odd_vencedora_e_realizada():
    # Vencedora de compra única: (stake+lucro)/stake = 1/preço = odd de entrada.
    # stake 40 (100 cotas a 0,40), lucro 60 → odd 2,5 = 1/0,40.
    odd = polymarket._calc_odd({"initialValue": 40.0, "cashPnl": 60.0, "avgPrice": 0.40})
    assert abs(odd - 2.5) < 1e-9


def test_calc_odd_perdedora_usa_entrada():
    # Sem lucro (perdedora/ativa): cai na odd de entrada 1/preço.
    odd = polymarket._calc_odd({"initialValue": 40.0, "cashPnl": -40.0, "avgPrice": 0.40})
    assert abs(odd - 2.5) < 1e-9
