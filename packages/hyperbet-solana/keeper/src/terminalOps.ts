import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { writeSync } from "node:fs";

import {
  TerminalLedger,
  type TerminalOperationConflictRecord,
  type TerminalOperationRecord,
  type TerminalOperationStatus,
} from "./terminalLedger";

const RECOVERY_STATUSES: TerminalOperationStatus[] = [
  "MANUAL_REVIEW",
  "DEAD_LETTER",
];
const ALL_STATUSES: TerminalOperationStatus[] = [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "MANUAL_REVIEW",
  "DEAD_LETTER",
];

function sanitizeCliError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/api-key=[^&\s]+/gi, "api-key=***")
    .replace(/authorization:\s*bearer\s+[^\s]+/gi, "authorization: Bearer ***")
    .slice(0, 2_000);
}

function printJson(value: unknown): void {
  writeSync(process.stdout.fd, `${JSON.stringify(value, null, 2)}\n`);
}

export type TerminalOpsCliIo = {
  writeJson?: (value: unknown) => void;
  writeError?: (message: string) => void;
};

function operatorView(
  record: TerminalOperationRecord,
  includeEvent = false,
): Omit<TerminalOperationRecord, "event"> & { event?: unknown } {
  const { event, ...safeRecord } = record;
  return includeEvent ? { ...safeRecord, event } : safeRecord;
}

function conflictView(
  conflict: TerminalOperationConflictRecord,
  includeEvent = false,
): TerminalOperationConflictRecord {
  const { event, ...safeInput } = conflict.conflictingInput;
  return {
    ...conflict,
    conflictingInput: includeEvent
      ? { ...safeInput, event }
      : ({
          ...safeInput,
        } as TerminalOperationConflictRecord["conflictingInput"]),
  };
}

function withLedger<T>(
  dbPath: string | undefined,
  fn: (ledger: TerminalLedger) => T,
  options: { readOnly?: boolean } = {},
): T {
  const ledger = new TerminalLedger(dbPath?.trim() || undefined, {
    readOnly: options.readOnly === true,
  });
  try {
    return fn(ledger);
  } finally {
    ledger.close();
  }
}

export async function runTerminalOpsCli(
  args: string[],
  io: TerminalOpsCliIo = {},
): Promise<number> {
  const writeJson = io.writeJson ?? printJson;
  const writeError =
    io.writeError ??
    ((message: string) => {
      writeSync(process.stderr.fd, message);
    });
  const cli = yargs(args)
    .scriptName("terminal-ops")
    .usage("$0 <command> [options]")
    .option("db", {
      type: "string",
      description: "Keeper SQLite path; defaults to KEEPER_DB_PATH",
    })
    .command(
      "list",
      "List terminal operations requiring attention",
      (command) =>
        command
          .option("status", {
            type: "array",
            string: true,
            choices: ALL_STATUSES,
            default: RECOVERY_STATUSES,
            description: "One or more operation statuses",
          })
          .option("limit", {
            type: "number",
            default: 50,
            description: "Maximum records (1-100)",
          }),
      (argv) => {
        withLedger(
          argv.db,
          (ledger) => {
            const statuses = (argv.status ??
              RECOVERY_STATUSES) as TerminalOperationStatus[];
            writeJson({
              summary: ledger.getSummary(),
              operations: ledger
                .listOperations({ statuses, limit: argv.limit })
                .map((record) => operatorView(record)),
            });
          },
          { readOnly: true },
        );
      },
    )
    .command(
      "inspect <id>",
      "Inspect one operation and its immutable operator history",
      (command) =>
        command
          .positional("id", {
            type: "number",
            demandOption: true,
            description: "Terminal operation id",
          })
          .option("include-event", {
            type: "boolean",
            default: false,
            description: "Include the persisted authoritative feed event",
          }),
      (argv) => {
        withLedger(
          argv.db,
          (ledger) => {
            const record = ledger.getById(argv.id);
            if (!record)
              throw new Error(`terminal operation ${argv.id} does not exist`);
            writeJson({
              operation: operatorView(record, argv.includeEvent),
              conflicts: ledger
                .getConflictRecords(argv.id)
                .map((conflict) => conflictView(conflict, argv.includeEvent)),
              auditEvents: ledger.getOperatorAuditEvents({
                operationId: argv.id,
              }),
            });
          },
          { readOnly: true },
        );
      },
    )
    .command(
      "requeue <id>",
      "Requeue one quarantined/dead-letter operation after independent verification",
      (command) =>
        command
          .positional("id", {
            type: "number",
            demandOption: true,
            description: "Terminal operation id",
          })
          .option("confirm-fingerprint", {
            type: "string",
            demandOption: true,
            description: "Exact 64-character fingerprint shown by inspect",
          })
          .option("actor", {
            type: "string",
            demandOption: true,
            description: "Stable operator identity for the audit trail",
          })
          .option("reason", {
            type: "string",
            demandOption: true,
            description: "10-500 character recovery justification",
          }),
      (argv) => {
        withLedger(argv.db, (ledger) => {
          const result = ledger.requeueForOperator({
            id: argv.id,
            expectedFingerprint: argv.confirmFingerprint,
            actor: argv.actor,
            reason: argv.reason,
          });
          writeJson({
            ok: true,
            operation: operatorView(result.operation),
            auditEvent: result.auditEvent,
          });
        });
      },
    )
    .command(
      "feed-status",
      "Inspect the durable authoritative-feed continuity checkpoint",
      () => {},
      (argv) => {
        withLedger(
          argv.db,
          (ledger) => {
            writeJson({
              checkpoint: ledger.getBettingFeedCheckpoint(),
            });
          },
          { readOnly: true },
        );
      },
    )
    .command(
      "history",
      "List immutable operator recovery actions",
      (command) =>
        command
          .option("id", {
            type: "number",
            description: "Optional terminal operation id",
          })
          .option("limit", {
            type: "number",
            default: 50,
            description: "Maximum records (1-100)",
          }),
      (argv) => {
        withLedger(
          argv.db,
          (ledger) => {
            writeJson({
              auditEvents: ledger.getOperatorAuditEvents({
                operationId: argv.id,
                limit: argv.limit,
              }),
            });
          },
          { readOnly: true },
        );
      },
    )
    .demandCommand(1)
    .strict()
    .recommendCommands()
    .help()
    .exitProcess(false)
    .fail((message, error) => {
      throw error ?? new Error(message);
    });

  try {
    await cli.parseAsync();
    return 0;
  } catch (error) {
    writeError(`[terminal-ops] ${sanitizeCliError(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runTerminalOpsCli(hideBin(process.argv));
}
