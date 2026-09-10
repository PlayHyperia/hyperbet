/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/duel_market.json`.
 */
export type DuelMarket = {
  "address": "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
  "metadata": {
    "name": "duelMarket",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "cancelOrder",
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "marketState",
          "writable": true
        },
        {
          "name": "duelState"
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "arg",
                "path": "orderId"
              }
            ]
          }
        },
        {
          "name": "priceLevel",
          "docs": [
            "continuation-pending order. Existing levels are owner/discriminator,",
            "identity, and bump checked in the instruction before any book mutation."
          ],
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": "u64"
        },
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "price",
          "type": "u16"
        }
      ]
    },
    {
      "name": "claim",
      "discriminator": [
        62,
        198,
        214,
        193,
        213,
        159,
        108,
        210
      ],
      "accounts": [
        {
          "name": "marketState",
          "writable": true
        },
        {
          "name": "duelState"
        },
        {
          "name": "userBalance",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  108,
                  97,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "marketMaker",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeEmptyPriceLevel",
      "docs": [
        "Closes an empty shared PriceLevel only to the wallet that originally",
        "funded the account. Any signer may submit cleanup, but cannot redirect",
        "the recorded recipient or close a level that still contains book state."
      ],
      "discriminator": [
        177,
        38,
        155,
        18,
        148,
        163,
        151,
        156
      ],
      "accounts": [
        {
          "name": "marketState"
        },
        {
          "name": "priceLevel",
          "writable": true
        },
        {
          "name": "rentRecipient",
          "writable": true
        },
        {
          "name": "closer",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "price",
          "type": "u16"
        }
      ]
    },
    {
      "name": "closeEmptyUserBalance",
      "docs": [
        "Returns an empty UserBalance PDA's rent to its owner. Resting-order",
        "placement initializes this account before any match occurs, so a user",
        "who later cancels or reclaims only unmatched liquidity can otherwise be",
        "left with a permanently empty account. This instruction is deliberately",
        "valid once matching has stopped and cannot move market custody. Keeping",
        "it unavailable while open prevents an active maker order from losing",
        "the balance account required by a later fill."
      ],
      "discriminator": [
        143,
        212,
        24,
        6,
        221,
        46,
        27,
        56
      ],
      "accounts": [
        {
          "name": "marketState"
        },
        {
          "name": "userBalance",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  108,
                  97,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "closeFilledOrder",
      "docs": [
        "Returns an inactive, fully filled Order PDA's rent to its original maker.",
        "This instruction deliberately has no vault or PriceLevel account: it cannot",
        "move collateral or shared-book rent, and is valid in every market lifecycle."
      ],
      "discriminator": [
        137,
        142,
        13,
        180,
        17,
        12,
        129,
        122
      ],
      "accounts": [
        {
          "name": "marketState"
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "arg",
                "path": "orderId"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "closeLosingBalance",
      "discriminator": [
        86,
        226,
        44,
        46,
        219,
        51,
        73,
        47
      ],
      "accounts": [
        {
          "name": "marketState",
          "writable": true
        },
        {
          "name": "duelState"
        },
        {
          "name": "userBalance",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  108,
                  97,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "continueOrder",
      "discriminator": [
        52,
        137,
        158,
        152,
        162,
        246,
        203,
        104
      ],
      "accounts": [
        {
          "name": "marketState",
          "writable": true
        },
        {
          "name": "duelState"
        },
        {
          "name": "userBalance",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  108,
                  97,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "arg",
                "path": "orderId"
              }
            ]
          }
        },
        {
          "name": "restingLevel",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "treasury"
        },
        {
          "name": "marketMaker"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "freezeConfig",
      "docs": [
        "One-way config freeze — after calling, update_config reverts permanently.",
        "Pause controls remain functional."
      ],
      "discriminator": [
        30,
        68,
        20,
        154,
        197,
        42,
        47,
        122
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "marketOperator",
          "type": "pubkey"
        },
        {
          "name": "treasury",
          "type": "pubkey"
        },
        {
          "name": "marketMaker",
          "type": "pubkey"
        },
        {
          "name": "tradeTreasuryFeeBps",
          "type": "u16"
        },
        {
          "name": "tradeMarketMakerFeeBps",
          "type": "u16"
        },
        {
          "name": "winningsMarketMakerFeeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "initializeMarket",
      "discriminator": [
        35,
        35,
        189,
        193,
        155,
        48,
        170,
        203
      ],
      "accounts": [
        {
          "name": "operator",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "duelState"
        },
        {
          "name": "marketState",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "duelKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "marketKind",
          "type": "u8"
        }
      ]
    },
    {
      "name": "placeOrder",
      "discriminator": [
        51,
        194,
        155,
        175,
        109,
        130,
        96,
        106
      ],
      "accounts": [
        {
          "name": "marketState",
          "writable": true
        },
        {
          "name": "duelState"
        },
        {
          "name": "userBalance",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  108,
                  97,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "newOrder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "arg",
                "path": "orderId"
              }
            ]
          }
        },
        {
          "name": "restingLevel",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "treasury"
        },
        {
          "name": "marketMaker"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": "u64"
        },
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "price",
          "type": "u16"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "orderBehavior",
          "type": "u8"
        }
      ]
    },
    {
      "name": "reclaimRestingOrder",
      "discriminator": [
        6,
        69,
        10,
        23,
        16,
        193,
        161,
        163
      ],
      "accounts": [
        {
          "name": "marketState",
          "writable": true
        },
        {
          "name": "duelState"
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              },
              {
                "kind": "arg",
                "path": "orderId"
              }
            ]
          }
        },
        {
          "name": "priceLevel",
          "docs": [
            "continuation-pending order. Existing levels are owner/discriminator,",
            "identity, and bump checked in the instruction before any book mutation."
          ],
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": "u64"
        },
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "price",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setMarketPaused",
      "docs": [
        "Emergency pause/unpause for market creation and order placement.",
        "Remains functional even after config freeze."
      ],
      "discriminator": [
        233,
        31,
        161,
        248,
        178,
        111,
        102,
        65
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "orderPlacementPaused",
          "type": "bool"
        },
        {
          "name": "marketCreationPaused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "syncMarketFromDuel",
      "docs": [
        "M-7: Intentionally NOT pause-gated. Market status must sync from oracle",
        "even during pause so that resolved/cancelled markets can transition and",
        "users can claim funds. Blocking sync during pause would lock user funds."
      ],
      "discriminator": [
        235,
        180,
        137,
        53,
        242,
        12,
        85,
        213
      ],
      "accounts": [
        {
          "name": "marketState",
          "writable": true
        },
        {
          "name": "duelState"
        }
      ],
      "args": []
    },
    {
      "name": "updateConfig",
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "authority",
          "type": "pubkey"
        },
        {
          "name": "marketOperator",
          "type": "pubkey"
        },
        {
          "name": "treasury",
          "type": "pubkey"
        },
        {
          "name": "marketMaker",
          "type": "pubkey"
        },
        {
          "name": "tradeTreasuryFeeBps",
          "type": "u16"
        },
        {
          "name": "tradeMarketMakerFeeBps",
          "type": "u16"
        },
        {
          "name": "winningsMarketMakerFeeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "withdrawResolvedTradeFees",
      "docs": [
        "Releases escrowed execution fees only after the canonical duel resolves.",
        "Any signer may submit the transaction, but the snapshotted recipients",
        "are immutable and the submitter cannot redirect or receive market funds."
      ],
      "discriminator": [
        47,
        5,
        186,
        114,
        167,
        92,
        18,
        49
      ],
      "accounts": [
        {
          "name": "marketState",
          "writable": true
        },
        {
          "name": "duelState"
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "marketMaker",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "marketState"
              }
            ]
          }
        },
        {
          "name": "submitter",
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "duelState",
      "discriminator": [
        149,
        213,
        59,
        165,
        124,
        116,
        145,
        120
      ]
    },
    {
      "name": "marketConfig",
      "discriminator": [
        119,
        255,
        200,
        88,
        252,
        82,
        128,
        24
      ]
    },
    {
      "name": "marketState",
      "discriminator": [
        0,
        125,
        123,
        215,
        95,
        96,
        164,
        194
      ]
    },
    {
      "name": "order",
      "discriminator": [
        134,
        173,
        223,
        185,
        77,
        86,
        28,
        51
      ]
    },
    {
      "name": "priceLevel",
      "discriminator": [
        236,
        106,
        90,
        162,
        188,
        41,
        219,
        186
      ]
    },
    {
      "name": "userBalance",
      "discriminator": [
        187,
        237,
        208,
        146,
        86,
        132,
        29,
        191
      ]
    }
  ],
  "events": [
    {
      "name": "claimSettled",
      "discriminator": [
        144,
        220,
        131,
        115,
        8,
        187,
        224,
        236
      ]
    },
    {
      "name": "emptyUserBalanceClosed",
      "discriminator": [
        174,
        21,
        99,
        167,
        59,
        135,
        73,
        177
      ]
    },
    {
      "name": "filledOrderClosed",
      "discriminator": [
        203,
        113,
        173,
        86,
        146,
        40,
        155,
        210
      ]
    },
    {
      "name": "losingBalanceClosed",
      "discriminator": [
        80,
        224,
        236,
        110,
        119,
        254,
        44,
        230
      ]
    },
    {
      "name": "marketCreated",
      "discriminator": [
        88,
        184,
        130,
        231,
        226,
        84,
        6,
        58
      ]
    },
    {
      "name": "marketSynced",
      "discriminator": [
        12,
        197,
        233,
        97,
        244,
        67,
        27,
        33
      ]
    },
    {
      "name": "orderCancelled",
      "discriminator": [
        108,
        56,
        128,
        68,
        168,
        113,
        168,
        239
      ]
    },
    {
      "name": "orderMatched",
      "discriminator": [
        211,
        0,
        178,
        174,
        61,
        245,
        45,
        250
      ]
    },
    {
      "name": "orderPlaced",
      "discriminator": [
        96,
        130,
        204,
        234,
        169,
        219,
        216,
        227
      ]
    },
    {
      "name": "priceLevelClosed",
      "discriminator": [
        140,
        218,
        175,
        31,
        175,
        3,
        188,
        23
      ]
    },
    {
      "name": "resolvedTradeFeesWithdrawn",
      "discriminator": [
        175,
        48,
        182,
        220,
        188,
        205,
        104,
        152
      ]
    },
    {
      "name": "restingOrderReclaimed",
      "discriminator": [
        119,
        79,
        122,
        108,
        115,
        169,
        15,
        78
      ]
    },
    {
      "name": "selfTradePolicyTriggered",
      "discriminator": [
        83,
        88,
        117,
        16,
        191,
        232,
        1,
        86
      ]
    },
    {
      "name": "tradeFeesEscrowed",
      "discriminator": [
        43,
        210,
        1,
        86,
        103,
        144,
        154,
        133
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorizedInitializer",
      "msg": "Only the upgrade authority can initialize config"
    },
    {
      "code": 6001,
      "name": "unauthorizedConfigAuthority",
      "msg": "Config authority is required for this action"
    },
    {
      "code": 6002,
      "name": "configAuthorityImmutable",
      "msg": "Config authority is immutable"
    },
    {
      "code": 6003,
      "name": "unauthorizedMarketOperator",
      "msg": "Market operator is not authorized"
    },
    {
      "code": 6004,
      "name": "invalidOperator",
      "msg": "Market operator pubkey is invalid"
    },
    {
      "code": 6005,
      "name": "invalidAuthority",
      "msg": "Authority pubkey is invalid"
    },
    {
      "code": 6006,
      "name": "invalidFeeAccount",
      "msg": "The provided fee account is invalid"
    },
    {
      "code": 6007,
      "name": "feeTooHigh",
      "msg": "Fee configuration exceeds 100%"
    },
    {
      "code": 6008,
      "name": "invalidMarketKind",
      "msg": "Only duel-winner markets are currently supported"
    },
    {
      "code": 6009,
      "name": "duelMismatch",
      "msg": "The duel account does not match the market"
    },
    {
      "code": 6010,
      "name": "marketCreationClosed",
      "msg": "Markets can only be created while betting is open or locked"
    },
    {
      "code": 6011,
      "name": "marketNotOpen",
      "msg": "Market is not open for new orders"
    },
    {
      "code": 6012,
      "name": "marketNotResolved",
      "msg": "Market is not resolved"
    },
    {
      "code": 6013,
      "name": "marketAlreadyResolved",
      "msg": "Market is already resolved or cancelled"
    },
    {
      "code": 6014,
      "name": "bettingClosed",
      "msg": "Betting is closed"
    },
    {
      "code": 6015,
      "name": "invalidSide",
      "msg": "Side must be bid (1) or ask (2)"
    },
    {
      "code": 6016,
      "name": "invalidOrderBehavior",
      "msg": "Order behavior must be GTC (0), IOC (1), or POST_ONLY (2)"
    },
    {
      "code": 6017,
      "name": "invalidPrice",
      "msg": "Price must be between 1 and 999"
    },
    {
      "code": 6018,
      "name": "invalidAmount",
      "msg": "Order amount must be greater than zero"
    },
    {
      "code": 6019,
      "name": "invalidOrderId",
      "msg": "Order id does not match the next expected id"
    },
    {
      "code": 6020,
      "name": "postOnlyWouldCross",
      "msg": "Post-only orders cannot cross the book"
    },
    {
      "code": 6021,
      "name": "precisionError",
      "msg": "The precision implied by amount and price is invalid"
    },
    {
      "code": 6022,
      "name": "costTooLow",
      "msg": "Order cost is too low"
    },
    {
      "code": 6023,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6024,
      "name": "priceLevelMismatch",
      "msg": "The supplied price level does not match the order"
    },
    {
      "code": 6025,
      "name": "priceLevelNotEmpty",
      "msg": "The supplied price level still contains book state"
    },
    {
      "code": 6026,
      "name": "invalidPriceLevelRentRecipient",
      "msg": "The supplied price-level rent recipient is not the immutable first payer"
    },
    {
      "code": 6027,
      "name": "orderSideMismatch",
      "msg": "The supplied order side does not match the stored order"
    },
    {
      "code": 6028,
      "name": "orderPriceMismatch",
      "msg": "The supplied order price does not match the stored order"
    },
    {
      "code": 6029,
      "name": "notOrderMaker",
      "msg": "Only the order maker can cancel this order"
    },
    {
      "code": 6030,
      "name": "orderMarketMismatch",
      "msg": "The order does not belong to the supplied market"
    },
    {
      "code": 6031,
      "name": "orderStillActive",
      "msg": "An active order cannot be closed as filled"
    },
    {
      "code": 6032,
      "name": "orderNotFullyFilled",
      "msg": "Only a fully filled order can be closed with this instruction"
    },
    {
      "code": 6033,
      "name": "orderStillLinked",
      "msg": "A filled order must be fully unlinked before its account can close"
    },
    {
      "code": 6034,
      "name": "missingMatchAccounts",
      "msg": "Required maker match accounts were not supplied"
    },
    {
      "code": 6035,
      "name": "missingTailOrder",
      "msg": "Required resting tail order account was not supplied"
    },
    {
      "code": 6036,
      "name": "missingLinkedOrderAccount",
      "msg": "A linked prev/next order account is missing"
    },
    {
      "code": 6037,
      "name": "invalidRemainingAccount",
      "msg": "Remaining account verification failed"
    },
    {
      "code": 6038,
      "name": "orderNotContinuable",
      "msg": "Order does not require continuation"
    },
    {
      "code": 6039,
      "name": "nothingToContinue",
      "msg": "No order remainder is left to continue"
    },
    {
      "code": 6040,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6041,
      "name": "nothingToWithdraw",
      "msg": "No resolved execution fees remain to withdraw"
    },
    {
      "code": 6042,
      "name": "feeEscrowInvariantViolation",
      "msg": "Execution-fee escrow accounting is inconsistent"
    },
    {
      "code": 6043,
      "name": "alreadyInitialized",
      "msg": "Config is already initialized"
    },
    {
      "code": 6044,
      "name": "orderPlacementPaused",
      "msg": "Order placement is paused"
    },
    {
      "code": 6045,
      "name": "marketCreationPaused",
      "msg": "Market creation is paused"
    },
    {
      "code": 6046,
      "name": "configFrozen",
      "msg": "Config is permanently frozen"
    },
    {
      "code": 6047,
      "name": "marketStillOpen",
      "msg": "Market is still open"
    },
    {
      "code": 6048,
      "name": "nothingToReclaim",
      "msg": "Nothing to reclaim"
    },
    {
      "code": 6049,
      "name": "marketHasNoWinner",
      "msg": "The resolved market has no canonical winner"
    },
    {
      "code": 6050,
      "name": "winningBalanceCannotBeClosed",
      "msg": "A balance with a winning entitlement cannot be closed as a loss"
    },
    {
      "code": 6051,
      "name": "nothingToClose",
      "msg": "Nothing remains in the losing balance to close"
    },
    {
      "code": 6052,
      "name": "invalidUserBalance",
      "msg": "The supplied user balance is not canonical"
    },
    {
      "code": 6053,
      "name": "userBalanceNotEmpty",
      "msg": "User balance still contains shares, collateral, or fee custody"
    }
  ],
  "types": [
    {
      "name": "claimSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "marketStatus"
              }
            }
          },
          {
            "name": "winner",
            "type": {
              "defined": {
                "name": "marketSide"
              }
            }
          },
          {
            "name": "payoutLamports",
            "type": "u64"
          },
          {
            "name": "winningsFeeLamports",
            "type": "u64"
          },
          {
            "name": "refundedTradeTreasuryFeeLamports",
            "type": "u64"
          },
          {
            "name": "refundedTradeMarketMakerFeeLamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "duelState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "duelKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "participantAHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "participantBHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "duelStatus"
              }
            }
          },
          {
            "name": "winner",
            "type": {
              "defined": {
                "name": "marketSide"
              }
            }
          },
          {
            "name": "betOpenTs",
            "type": "i64"
          },
          {
            "name": "betCloseTs",
            "type": "i64"
          },
          {
            "name": "duelStartTs",
            "type": "i64"
          },
          {
            "name": "duelEndTs",
            "type": "i64"
          },
          {
            "name": "seed",
            "type": "u64"
          },
          {
            "name": "resultHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "replayHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "activeProposal",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "pendingWinner",
            "type": {
              "defined": {
                "name": "marketSide"
              }
            }
          },
          {
            "name": "pendingSeed",
            "type": "u64"
          },
          {
            "name": "pendingResultHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "pendingReplayHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "pendingDuelEndTs",
            "type": "i64"
          },
          {
            "name": "pendingProposedAt",
            "type": "i64"
          },
          {
            "name": "pendingChallenged",
            "type": "bool"
          },
          {
            "name": "metadataUri",
            "type": "string"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "competitiveSnapshotVersion",
            "type": "u32"
          },
          {
            "name": "competitiveSnapshotDigest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "accountSchemaVersion",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "duelStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "scheduled"
          },
          {
            "name": "bettingOpen"
          },
          {
            "name": "locked"
          },
          {
            "name": "proposed"
          },
          {
            "name": "challenged"
          },
          {
            "name": "resolved"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "emptyUserBalanceClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "filledOrderClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "orderId",
            "type": "u64"
          },
          {
            "name": "maker",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "losingBalanceClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "aShares",
            "type": "u64"
          },
          {
            "name": "bShares",
            "type": "u64"
          },
          {
            "name": "aLockedLamports",
            "type": "u64"
          },
          {
            "name": "bLockedLamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "marketConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "marketOperator",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "marketMaker",
            "type": "pubkey"
          },
          {
            "name": "tradeTreasuryFeeBps",
            "type": "u16"
          },
          {
            "name": "tradeMarketMakerFeeBps",
            "type": "u16"
          },
          {
            "name": "winningsMarketMakerFeeBps",
            "type": "u16"
          },
          {
            "name": "orderPlacementPaused",
            "type": "bool"
          },
          {
            "name": "marketCreationPaused",
            "type": "bool"
          },
          {
            "name": "configFrozen",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "duelKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "marketKind",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketSide",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "none"
          },
          {
            "name": "a"
          },
          {
            "name": "b"
          }
        ]
      }
    },
    {
      "name": "marketState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "duelState",
            "type": "pubkey"
          },
          {
            "name": "duelKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "marketKind",
            "type": "u8"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "marketStatus"
              }
            }
          },
          {
            "name": "winner",
            "type": {
              "defined": {
                "name": "marketSide"
              }
            }
          },
          {
            "name": "tradeTreasuryFeeBpsSnapshot",
            "type": "u16"
          },
          {
            "name": "tradeMarketMakerFeeBpsSnapshot",
            "type": "u16"
          },
          {
            "name": "winningsMarketMakerFeeBpsSnapshot",
            "type": "u16"
          },
          {
            "name": "nextOrderId",
            "type": "u64"
          },
          {
            "name": "bestBid",
            "type": "u16"
          },
          {
            "name": "bestAsk",
            "type": "u16"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "marketMaker",
            "type": "pubkey"
          },
          {
            "name": "accruedTradeTreasuryFeeLamports",
            "type": "u64"
          },
          {
            "name": "accruedTradeMarketMakerFeeLamports",
            "type": "u64"
          },
          {
            "name": "bidBitmap",
            "type": {
              "array": [
                "u64",
                16
              ]
            }
          },
          {
            "name": "askBitmap",
            "type": {
              "array": [
                "u64",
                16
              ]
            }
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "locked"
          },
          {
            "name": "resolved"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "marketSynced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "duelKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "marketStatus"
              }
            }
          },
          {
            "name": "winner",
            "type": {
              "defined": {
                "name": "marketSide"
              }
            }
          }
        ]
      }
    },
    {
      "name": "order",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketState",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u16"
          },
          {
            "name": "orderBehavior",
            "type": "u8"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "filled",
            "type": "u64"
          },
          {
            "name": "prevOrderId",
            "type": "u64"
          },
          {
            "name": "nextOrderId",
            "type": "u64"
          },
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "continuationPending",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "orderCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "orderId",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "orderMatched",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "makerOrderId",
            "type": "u64"
          },
          {
            "name": "takerOrderId",
            "type": "u64"
          },
          {
            "name": "matchedAmount",
            "type": "u64"
          },
          {
            "name": "price",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "orderPlaced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "orderId",
            "type": "u64"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u16"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceLevel",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketState",
            "type": "pubkey"
          },
          {
            "name": "rentRecipient",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u16"
          },
          {
            "name": "headOrderId",
            "type": "u64"
          },
          {
            "name": "tailOrderId",
            "type": "u64"
          },
          {
            "name": "totalOpen",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "priceLevelClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u16"
          },
          {
            "name": "rentRecipient",
            "type": "pubkey"
          },
          {
            "name": "closer",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "resolvedTradeFeesWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "marketMaker",
            "type": "pubkey"
          },
          {
            "name": "treasuryFeeLamports",
            "type": "u64"
          },
          {
            "name": "marketMakerFeeLamports",
            "type": "u64"
          },
          {
            "name": "submitter",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "restingOrderReclaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "orderId",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "selfTradePolicyTriggered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketRef",
            "type": "pubkey"
          },
          {
            "name": "makerAuthority",
            "type": "pubkey"
          },
          {
            "name": "takerAuthority",
            "type": "pubkey"
          },
          {
            "name": "makerOrderId",
            "type": "u64"
          },
          {
            "name": "takerOrderId",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tradeFeesEscrowed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": "pubkey"
          },
          {
            "name": "orderId",
            "type": "u64"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "executedCostLamports",
            "type": "u64"
          },
          {
            "name": "treasuryFeeLamports",
            "type": "u64"
          },
          {
            "name": "marketMakerFeeLamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "userBalance",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "marketState",
            "type": "pubkey"
          },
          {
            "name": "aShares",
            "type": "u64"
          },
          {
            "name": "bShares",
            "type": "u64"
          },
          {
            "name": "aLockedLamports",
            "type": "u64"
          },
          {
            "name": "bLockedLamports",
            "type": "u64"
          },
          {
            "name": "tradeTreasuryFeeLamports",
            "type": "u64"
          },
          {
            "name": "tradeMarketMakerFeeLamports",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
