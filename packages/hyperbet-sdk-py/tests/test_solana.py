import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import base58
import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from hyperbet_sdk.solana.client import (
    HyperbetSolanaClient,
    duel_key_hex_to_bytes,
    find_duel_state_pda,
    find_market_state_pda,
)
from hyperbet_sdk.types import (
    MARKET_KIND_DUEL_WINNER,
    ORDER_BEHAVIOR_GTC,
    SIDE_ASK,
    SIDE_BID,
    ClaimParams,
    CreateOrderParams,
    OrderActionParams,
)

DUEL_KEY = "1f1e1d1c1b1a19181716151413121110f1e2d3c4b5a697887766554433221100"
ORACLE_PROGRAM = Pubkey.from_string("FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu")
MARKET_PROGRAM = Pubkey.from_string("7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG")


def test_canonical_market_kind_and_pdas():
    assert MARKET_KIND_DUEL_WINNER == 1
    duel = find_duel_state_pda(ORACLE_PROGRAM, duel_key_hex_to_bytes(DUEL_KEY))
    assert str(duel) == "g1qh9B6wiBujNncuDRHJuKQcRmsAYUYRdpcp3VNXKh6"
    assert (
        str(find_market_state_pda(MARKET_PROGRAM, duel))
        == "GQfzUQRCDWdiUgP2bCdkhDpdGGp9hhD1ERab6PTX7HAp"
    )


def test_order_input_rejects_program_precision_drift():
    with pytest.raises(ValueError, match="divisible by 1000"):
        CreateOrderParams(
            duel_key_hex="0" * 64,
            side="YES",
            outcome_price_millis=500,
            amount_lamports=1_001,
        )


@pytest.mark.parametrize(
    "params",
    [
        lambda: CreateOrderParams(
            duel_key_hex="not-a-duel-key",
            side="YES",
            outcome_price_millis=500,
            amount_lamports=10_000,
        ),
        lambda: OrderActionParams(duel_key_hex="not-a-duel-key", order_id=1),
        lambda: ClaimParams(duel_key_hex="not-a-duel-key"),
    ],
)
def test_every_action_rejects_invalid_duel_identity(params):
    with pytest.raises(ValueError, match="32-byte hex string"):
        params()


@pytest.fixture
def mocked_client():
    keypair = Keypair()
    private_key = base58.b58encode(bytes(keypair)).decode("utf-8")
    duel_program = MagicMock()
    oracle_program = MagicMock()
    duel_program.account = {
        "MarketState": SimpleNamespace(fetch=AsyncMock()),
        "PriceLevel": SimpleNamespace(
            all=AsyncMock(return_value=[]),
            fetch=AsyncMock(),
            fetch_nullable=AsyncMock(return_value=None),
        ),
        "Order": SimpleNamespace(fetch=AsyncMock()),
    }
    duel_program.rpc = {
        "place_order": AsyncMock(return_value="place-signature"),
        "cancel_order": AsyncMock(return_value="cancel-signature"),
        "reclaim_resting_order": AsyncMock(return_value="reclaim-signature"),
        "close_filled_order": AsyncMock(return_value="close-signature"),
        "claim": AsyncMock(return_value="claim-signature"),
        "close_losing_balance": AsyncMock(return_value="loser-signature"),
    }
    oracle_program.account = {
        "DuelState": SimpleNamespace(fetch=AsyncMock(return_value=SimpleNamespace()))
    }

    with patch(
        "hyperbet_sdk.solana.client.Program",
        side_effect=[duel_program, oracle_program],
    ):
        client = HyperbetSolanaClient(
            "http://localhost:8899",
            private_key,
            str(MARKET_PROGRAM),
            str(ORACLE_PROGRAM),
        )

    duel_state = client.get_duel_state_pda(duel_key_hex_to_bytes(DUEL_KEY))
    market_state = client.get_market_pda(duel_state)
    market_account = SimpleNamespace(
        duel_state=duel_state,
        market_kind=MARKET_KIND_DUEL_WINNER,
        next_order_id=42,
        treasury=keypair.pubkey(),
        market_maker=keypair.pubkey(),
    )
    duel_program.account["MarketState"].fetch.return_value = market_account
    yield client, duel_program, market_state, keypair


@pytest.mark.asyncio
async def test_place_order_uses_current_instruction_graph(mocked_client):
    client, program, _, _ = mocked_client
    result = await client.place_order(
        CreateOrderParams(
            duel_key_hex=DUEL_KEY,
            side="NO",
            outcome_price_millis=400,
            amount_lamports=10_000,
        )
    )
    assert result == "place-signature"
    call = program.rpc["place_order"].await_args
    assert call.args == (42, SIDE_ASK, 600, 10_000, ORDER_BEHAVIOR_GTC)
    assert set(call.kwargs["ctx"].accounts) == {
        "market_state",
        "duel_state",
        "user_balance",
        "new_order",
        "resting_level",
        "config",
        "treasury",
        "market_maker",
        "vault",
        "user",
        "system_program",
    }


@pytest.mark.asyncio
async def test_cancel_and_reclaim_revalidate_owned_order(mocked_client):
    client, program, market_state, keypair = mocked_client
    order = SimpleNamespace(
        id=7,
        market_state=market_state,
        maker=keypair.pubkey(),
        side=SIDE_BID,
        price=500,
        amount=10_000,
        filled=2_000,
        prev_order_id=0,
        next_order_id=0,
        active=True,
        continuation_pending=False,
    )
    level = SimpleNamespace(
        market_state=market_state,
        side=SIDE_BID,
        price=500,
        head_order_id=7,
        tail_order_id=7,
        total_open=8_000,
    )
    program.account["Order"].fetch.return_value = order
    program.account["PriceLevel"].fetch.return_value = level
    params = OrderActionParams(duel_key_hex=DUEL_KEY, order_id=7)

    assert await client.cancel_order(params) == "cancel-signature"
    assert await client.reclaim_order(params) == "reclaim-signature"
    assert program.rpc["cancel_order"].await_args.args == (7, SIDE_BID, 500)
    assert program.rpc["reclaim_resting_order"].await_args.args == (
        7,
        SIDE_BID,
        500,
    )


@pytest.mark.asyncio
async def test_claim_and_loser_cleanup_are_distinct(mocked_client):
    client, program, _, _ = mocked_client
    params = ClaimParams(duel_key_hex=DUEL_KEY)
    assert await client.claim(params) == "claim-signature"
    assert await client.close_losing_balance(params) == "loser-signature"
    program.rpc["claim"].assert_awaited_once()
    program.rpc["close_losing_balance"].assert_awaited_once()


def test_idl_contract_matches_published_transaction_builders():
    idl_path = (
        Path(__file__).parents[1]
        / "hyperbet_sdk"
        / "solana"
        / "idl"
        / "duel_market.json"
    )
    idl = json.loads(idl_path.read_text(encoding="utf-8"))
    expected = {
        "place_order": (
            ["order_id", "side", "price", "amount", "order_behavior"],
            [
                "market_state",
                "duel_state",
                "user_balance",
                "new_order",
                "resting_level",
                "config",
                "treasury",
                "market_maker",
                "vault",
                "user",
                "system_program",
            ],
        ),
        "cancel_order": (
            ["order_id", "side", "price"],
            [
                "market_state",
                "duel_state",
                "order",
                "price_level",
                "vault",
                "user",
                "system_program",
            ],
        ),
        "claim": (
            [],
            [
                "market_state",
                "duel_state",
                "user_balance",
                "config",
                "market_maker",
                "vault",
                "user",
                "system_program",
            ],
        ),
    }
    instructions = {item["name"]: item for item in idl["instructions"]}
    for name, (args, accounts) in expected.items():
        assert [item["name"] for item in instructions[name]["args"]] == args
        assert [item["name"] for item in instructions[name]["accounts"]] == accounts
