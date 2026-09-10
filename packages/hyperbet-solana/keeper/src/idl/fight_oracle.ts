/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/fight_oracle.json`.
 */
export type FightOracle = {
  "address": "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
  "metadata": {
    "name": "fightOracle",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "cancelDuel",
      "discriminator": [
        83,
        124,
        224,
        237,
        235,
        44,
        38,
        57
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracleConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
          "name": "duelState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  117,
                  101,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "duelKey"
              }
            ]
          }
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
          "name": "metadataUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "challengeResult",
      "discriminator": [
        62,
        59,
        36,
        3,
        171,
        25,
        241,
        163
      ],
      "accounts": [
        {
          "name": "challenger",
          "signer": true
        },
        {
          "name": "oracleConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
          "name": "duelState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  117,
                  101,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "duelKey"
              }
            ]
          }
        },
        {
          "name": "proposalRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "duel_state.duel_key",
                "account": "duelState"
              },
              {
                "kind": "account",
                "path": "duel_state.pending_result_hash",
                "account": "duelState"
              },
              {
                "kind": "account",
                "path": "duel_state.pending_replay_hash",
                "account": "duelState"
              }
            ]
          }
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
          "name": "metadataUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "finalizeResult",
      "discriminator": [
        217,
        193,
        113,
        98,
        13,
        191,
        186,
        78
      ],
      "accounts": [
        {
          "name": "finalizer",
          "signer": true
        },
        {
          "name": "oracleConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
          "name": "duelState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  117,
                  101,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "duelKey"
              }
            ]
          }
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
          "name": "metadataUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "freezeOracleConfig",
      "docs": [
        "One-way config freeze — after calling, update_oracle_config reverts permanently.",
        "Pause controls remain functional."
      ],
      "discriminator": [
        82,
        213,
        40,
        194,
        183,
        48,
        32,
        246
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "oracleConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
      "name": "initializeOracle",
      "discriminator": [
        144,
        223,
        131,
        120,
        196,
        253,
        181,
        99
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracleConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
          "address": "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu"
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
          "name": "reporter",
          "type": "pubkey"
        },
        {
          "name": "finalizer",
          "type": "pubkey"
        },
        {
          "name": "challenger",
          "type": "pubkey"
        },
        {
          "name": "disputeWindowSecs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "proposeResult",
      "discriminator": [
        7,
        96,
        132,
        38,
        128,
        145,
        133,
        242
      ],
      "accounts": [
        {
          "name": "reporter",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracleConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
          "name": "duelState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  117,
                  101,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "duelKey"
              }
            ]
          }
        },
        {
          "name": "proposalRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "duelKey"
              },
              {
                "kind": "arg",
                "path": "resultHash"
              },
              {
                "kind": "arg",
                "path": "replayHash"
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
          "name": "winner",
          "type": {
            "defined": {
              "name": "marketSide"
            }
          }
        },
        {
          "name": "seed",
          "type": "u64"
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
          "name": "resultHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "duelEndTs",
          "type": "i64"
        },
        {
          "name": "metadataUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "reproposeResult",
      "discriminator": [
        67,
        248,
        197,
        39,
        189,
        160,
        132,
        182
      ],
      "accounts": [
        {
          "name": "reporter",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracleConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
          "name": "duelState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  117,
                  101,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "duelKey"
              }
            ]
          }
        },
        {
          "name": "proposalRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "duelKey"
              },
              {
                "kind": "arg",
                "path": "resultHash"
              },
              {
                "kind": "arg",
                "path": "replayHash"
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
          "name": "winner",
          "type": {
            "defined": {
              "name": "marketSide"
            }
          }
        },
        {
          "name": "seed",
          "type": "u64"
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
          "name": "resultHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "duelEndTs",
          "type": "i64"
        },
        {
          "name": "metadataUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "setOraclePaused",
      "docs": [
        "Emergency pause/unpause — remains functional even after config freeze."
      ],
      "discriminator": [
        61,
        243,
        64,
        36,
        121,
        38,
        141,
        241
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "oracleConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "updateOracleConfig",
      "discriminator": [
        83,
        16,
        11,
        254,
        57,
        99,
        156,
        58
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "oracleConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
          "name": "reporter",
          "type": "pubkey"
        },
        {
          "name": "finalizer",
          "type": "pubkey"
        },
        {
          "name": "challenger",
          "type": "pubkey"
        },
        {
          "name": "disputeWindowSecs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "upsertDuel",
      "discriminator": [
        174,
        7,
        139,
        223,
        70,
        128,
        251,
        128
      ],
      "accounts": [
        {
          "name": "reporter",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracleConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
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
          "name": "duelState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  117,
                  101,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "duelKey"
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
          "name": "metadataUri",
          "type": "string"
        },
        {
          "name": "status",
          "type": {
            "defined": {
              "name": "duelStatus"
            }
          }
        }
      ]
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
      "name": "oracleConfig",
      "discriminator": [
        133,
        196,
        152,
        50,
        27,
        21,
        145,
        254
      ]
    },
    {
      "name": "proposalRecord",
      "discriminator": [
        154,
        180,
        211,
        203,
        232,
        223,
        142,
        147
      ]
    }
  ],
  "events": [
    {
      "name": "duelCancelled",
      "discriminator": [
        138,
        79,
        20,
        163,
        207,
        11,
        111,
        213
      ]
    },
    {
      "name": "duelResolved",
      "discriminator": [
        224,
        245,
        214,
        212,
        111,
        151,
        50,
        5
      ]
    },
    {
      "name": "duelUpserted",
      "discriminator": [
        37,
        241,
        232,
        195,
        196,
        76,
        240,
        120
      ]
    },
    {
      "name": "resultChallenged",
      "discriminator": [
        221,
        74,
        171,
        75,
        157,
        103,
        164,
        252
      ]
    },
    {
      "name": "resultProposed",
      "discriminator": [
        216,
        229,
        56,
        182,
        48,
        192,
        53,
        251
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Unauthorized oracle action"
    },
    {
      "code": 6001,
      "name": "unauthorizedInitializer",
      "msg": "Only the current upgrade authority can initialize the oracle"
    },
    {
      "code": 6002,
      "name": "invalidReporter",
      "msg": "Reporter pubkey cannot be the default address"
    },
    {
      "code": 6003,
      "name": "invalidAuthority",
      "msg": "Authority pubkey cannot be the default address"
    },
    {
      "code": 6004,
      "name": "invalidFinalizer",
      "msg": "Finalizer pubkey cannot be the default address"
    },
    {
      "code": 6005,
      "name": "invalidChallenger",
      "msg": "Challenger pubkey cannot be the default address"
    },
    {
      "code": 6006,
      "name": "invalidDisputeWindow",
      "msg": "Dispute window must be positive"
    },
    {
      "code": 6007,
      "name": "invalidBetWindow",
      "msg": "Betting window is invalid"
    },
    {
      "code": 6008,
      "name": "invalidParticipants",
      "msg": "Participants must be present and distinct"
    },
    {
      "code": 6009,
      "name": "invalidLifecycleTransition",
      "msg": "Duel lifecycle transition is invalid"
    },
    {
      "code": 6010,
      "name": "duelKeyMismatch",
      "msg": "The provided duel key does not match the stored duel"
    },
    {
      "code": 6011,
      "name": "duelAlreadyFinalized",
      "msg": "The duel is already finalized"
    },
    {
      "code": 6012,
      "name": "duelAlreadyCancelled",
      "msg": "The duel was cancelled and cannot be resolved"
    },
    {
      "code": 6013,
      "name": "invalidWinner",
      "msg": "Winner must be side A or side B"
    },
    {
      "code": 6014,
      "name": "notProposed",
      "msg": "No active proposal exists"
    },
    {
      "code": 6015,
      "name": "alreadyChallenged",
      "msg": "Proposal already challenged"
    },
    {
      "code": 6016,
      "name": "challengeWindowExpired",
      "msg": "Challenge window already expired"
    },
    {
      "code": 6017,
      "name": "disputeWindowActive",
      "msg": "Dispute window still active"
    },
    {
      "code": 6018,
      "name": "configAuthorityImmutable",
      "msg": "Config authority is immutable"
    },
    {
      "code": 6019,
      "name": "bettingWindowActive",
      "msg": "Cannot propose result while betting window is still active"
    },
    {
      "code": 6020,
      "name": "notChallenged",
      "msg": "Duel must be in Challenged status for reproposal"
    },
    {
      "code": 6021,
      "name": "invalidResultTime",
      "msg": "Result timestamp must be at or after duel start and no later than chain time"
    },
    {
      "code": 6022,
      "name": "proposalExists",
      "msg": "Proposal evidence identity has already been used"
    },
    {
      "code": 6023,
      "name": "proposalRecordMismatch",
      "msg": "Proposal record does not match the duel's active proposal"
    },
    {
      "code": 6024,
      "name": "participantHashImmutable",
      "msg": "Participant hashes are immutable after betting opens"
    },
    {
      "code": 6025,
      "name": "timingImmutable",
      "msg": "Duel timing is immutable after betting opens"
    },
    {
      "code": 6026,
      "name": "invalidCompetitiveSnapshot",
      "msg": "Competitive snapshot version and digest must be present"
    },
    {
      "code": 6027,
      "name": "competitiveSnapshotImmutable",
      "msg": "Competitive snapshot commitment is immutable after betting opens"
    },
    {
      "code": 6028,
      "name": "resultHashMismatch",
      "msg": "Result hash does not match the canonical duel outcome commitment"
    },
    {
      "code": 6029,
      "name": "unsupportedAccountSchema",
      "msg": "Account schema version is unsupported; use a fresh v2 program identity"
    },
    {
      "code": 6030,
      "name": "alreadyInitialized",
      "msg": "Config is already initialized"
    },
    {
      "code": 6031,
      "name": "oraclePaused",
      "msg": "Oracle operations are paused"
    },
    {
      "code": 6032,
      "name": "configFrozen",
      "msg": "Config is permanently frozen"
    },
    {
      "code": 6033,
      "name": "metadataUriTooLong",
      "msg": "Metadata URI exceeds 200 byte limit"
    },
    {
      "code": 6034,
      "name": "configNotFrozen",
      "msg": "Oracle config must be permanently frozen before betting opens"
    }
  ],
  "types": [
    {
      "name": "duelCancelled",
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
            "name": "metadataUri",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "duelResolved",
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
            "name": "proposalId",
            "type": {
              "array": [
                "u8",
                32
              ]
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
            "name": "seed",
            "type": "u64"
          },
          {
            "name": "duelEndTs",
            "type": "i64"
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
            "name": "metadataUri",
            "type": "string"
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
      "name": "duelUpserted",
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
            "name": "status",
            "type": {
              "defined": {
                "name": "duelStatus"
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
            "name": "metadataUri",
            "type": "string"
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
      "name": "oracleConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "reporter",
            "type": "pubkey"
          },
          {
            "name": "finalizer",
            "type": "pubkey"
          },
          {
            "name": "challenger",
            "type": "pubkey"
          },
          {
            "name": "disputeWindowSecs",
            "type": "i64"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "configFrozen",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "accountSchemaVersion",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "proposalRecord",
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
            "name": "proposalId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
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
            "name": "winner",
            "type": {
              "defined": {
                "name": "marketSide"
              }
            }
          },
          {
            "name": "seed",
            "type": "u64"
          },
          {
            "name": "duelEndTs",
            "type": "i64"
          },
          {
            "name": "proposedAt",
            "type": "i64"
          },
          {
            "name": "challenged",
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
      "name": "resultChallenged",
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
            "name": "proposalId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "metadataUri",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "resultProposed",
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
            "name": "proposalId",
            "type": {
              "array": [
                "u8",
                32
              ]
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
            "name": "seed",
            "type": "u64"
          },
          {
            "name": "duelEndTs",
            "type": "i64"
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
            "name": "metadataUri",
            "type": "string"
          }
        ]
      }
    }
  ]
};
