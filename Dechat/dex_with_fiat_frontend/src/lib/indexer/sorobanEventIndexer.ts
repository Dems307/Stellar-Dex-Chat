/**
 * Durable Soroban Event Indexer with Ledger Cursors
 * Addresses Issue #86: Turn contract events into a queryable, restart-safe source
 * for history and operations.
 */

export interface SorobanEventRecord {
  id: string; // `${ledger}_${txHash}_${eventIndex}`
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  schemaVersion: number;
  topic: string[];
  rawPayload: string;
  decodedPayload: Record<string, unknown> | null;
  timestamp: number;
}

export interface IndexerCursor {
  lastLedger: number;
  lastEventIndex: number;
  updatedAt: number;
}

/**
 * Durable checkpoint persisted alongside the events it covers.
 * `ledgerHash` is the authoritative hash of `lastLedger` used for reorg detection.
 */
export interface IndexerCheckpoint extends IndexerCursor {
  ledgerHash?: string;
}

export interface CommitBatchResult {
  ingested: number;
  duplicatesSkipped: number;
  /** True when the conditional write refused to overwrite newer canonical events. */
  rejectedAsStale: boolean;
}

/**
 * Persistence adapter. Implementations MUST commit events and the cursor
 * atomically (single transaction) so a crash can never leave the cursor
 * ahead of the stored events (or vice versa).
 */
export interface IndexerPersistenceAdapter {
  loadCheckpoint(): Promise<IndexerCheckpoint | null>;
  loadEvents(fromLedger: number, toLedger: number): Promise<SorobanEventRecord[]>;
  /**
   * Atomically persist `events` and `checkpoint`. Must refuse (return false)
   * when the stored checkpoint is newer than `checkpoint` (conditional write).
   */
  commitBatch(events: SorobanEventRecord[], checkpoint: IndexerCheckpoint): Promise<boolean>;
  /** Delete events strictly after `checkpoint` and reset the cursor atomically. */
  rollbackTo(checkpoint: IndexerCheckpoint): Promise<void>;
  /** Acquire the backfill lock; returns false when another job holds it. */
  acquireBackfillLock(owner: string, ttlMs: number): Promise<boolean>;
  releaseBackfillLock(owner: string): Promise<void>;
}

export interface BackfillCancellationToken {
  readonly cancelled: boolean;
}

export class SorobanEventIndexer {
  private events: Map<string, SorobanEventRecord> = new Map();
  private cursor: IndexerCheckpoint = { lastLedger: 0, lastEventIndex: 0, updatedAt: 0 };
  private supportedSchemas: Set<number> = new Set([1]);
  private adapter?: IndexerPersistenceAdapter;
  private backfillOwner?: string;

  constructor(initialCursor?: IndexerCheckpoint, adapter?: IndexerPersistenceAdapter) {
    if (initialCursor) {
      this.cursor = { ...initialCursor };
    }
    this.adapter = adapter;
  }

  /**
   * Resume from the last committed checkpoint. Must be awaited before ingesting.
   */
  public async initialize(): Promise<IndexerCheckpoint> {
    if (!this.adapter) return this.getCursor();
    const checkpoint = await this.adapter.loadCheckpoint();
    if (checkpoint) {
      this.cursor = { ...checkpoint };
    }
    return this.getCursor();
  }

  public getCursor(): IndexerCheckpoint {
    return { ...this.cursor };
  }

  public getCheckpoint(): IndexerCheckpoint {
    return this.getCursor();
  }

  /**
   * Roll back to a trusted checkpoint (reorg repair). Removes all cached and
   * persisted events after the checkpoint so they can be re-ingested.
   */
  public async rollbackToCheckpoint(checkpoint: IndexerCheckpoint): Promise<void> {
    if (this.adapter) {
      await this.adapter.rollbackTo(checkpoint);
    }
    for (const [key, record] of this.events) {
      if (
        record.ledger > checkpoint.lastLedger ||
        (record.ledger === checkpoint.lastLedger && record.eventIndex > checkpoint.lastEventIndex)
      ) {
        this.events.delete(key);
      }
    }
    this.cursor = { ...checkpoint };
  }

  public async acquireBackfillLock(owner: string, ttlMs: number = 60_000): Promise<boolean> {
    if (!this.adapter) return true;
    const acquired = await this.adapter.acquireBackfillLock(owner, ttlMs);
    if (acquired) this.backfillOwner = owner;
    return acquired;
  }

  public async releaseBackfillLock(): Promise<void> {
    if (this.adapter && this.backfillOwner) {
      await this.adapter.releaseBackfillLock(this.backfillOwner);
    }
    this.backfillOwner = undefined;
  }

  /**
   * Ingest a batch of events idempotently without duplicates or gaps.
   * When an adapter is configured, events and the cursor are committed atomically.
   * Pass a cancellation token for backfill batches to abort between records.
   */
  public async ingestEvents(
    batch: SorobanEventRecord[],
    cancellation?: BackfillCancellationToken,
  ): Promise<CommitBatchResult> {
    let duplicatesSkipped = 0;
    const pending: SorobanEventRecord[] = [];
    const pendingKeys = new Set<string>();

    // Stable sort by ledger then eventIndex (canonical ordering)
    const sorted = [...batch].sort((a, b) => {
      if (a.ledger !== b.ledger) return a.ledger - b.ledger;
      if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
      return a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0;
    });

    const active = this.getActive();

    for (const record of sorted) {
      if (cancellation?.cancelled) break;

      const recordKey = `${record.ledger}_${record.txHash}_${record.eventIndex}`;
      if (this.events.has(recordKey) || pendingKeys.has(recordKey)) {
        duplicatesSkipped++;
        continue;
      }

      // Schema compatibility verification
      if (!this.supportedSchemas.has(record.schemaVersion)) {
        console.warn(`Encountered unsupported event schema version: ${record.schemaVersion}`);
      }

      pending.push({ ...record, id: recordKey });
      pendingKeys.add(recordKey);
    }

    if (pending.length === 0) {
      return { ingested: 0, duplicatesSkipped, rejectedAsStale: false };
    }

    // Compute the new cursor from the highest pending record.
    let nextCursor: IndexerCheckpoint = { ...this.cursor };
    for (const record of pending) {
      if (
        record.ledger > nextCursor.lastLedger ||
        (record.ledger === nextCursor.lastLedger && record.eventIndex > nextCursor.lastEventIndex)
      ) {
        nextCursor = {
          lastLedger: record.ledger,
          lastEventIndex: record.eventIndex,
          updatedAt: Date.now(),
        };
      }
    }

    if (this.adapter) {
      const committed = await this.adapter.commitBatch(pending, nextCursor);
      if (!committed) {
        // Conditional write refused: stored data is newer than this batch.
        return { ingested: 0, duplicatesSkipped, rejectedAsStale: true };
      }
    }

    for (const record of pending) {
      this.events.set(record.id, record);
    }
    this.cursor = nextCursor;

    return { ingested: pending.length, duplicatesSkipped, rejectedAsStale: false };
  }

  /**
   * Begin a parallel rebuild into a fresh shadow projection namespace.
   * The active projection remains untouched and fully readable.
   */
  public beginRebuild(): ProjectionVersion {
    if (this.shadowVersion !== null) {
      throw new Error(`Rebuild already in progress for version ${this.shadowVersion}`);
    }
    const version = this.nextVersion++;
    const active = this.getActive();
    const shadow: ProjectionState = {
      events: new Map(),
      cursor: { ...active.cursor },
      meta: {
        version,
        status: 'building',
        checksum: computeChecksum([]),
        eventCount: 0,
        createdAt: Date.now(),
      },
    };
    this.projections.set(version, shadow);
    this.shadowVersion = version;
    return { ...shadow.meta };
  }

  /**
   * Ingest events into the shadow projection only. Never mutates the active projection.
   */
  public ingestIntoShadow(batch: SorobanEventRecord[]): { ingested: number; duplicatesSkipped: number } {
    if (this.shadowVersion === null) {
      throw new Error('No rebuild in progress; call beginRebuild() first');
    }
    const shadow = this.projections.get(this.shadowVersion);
    if (!shadow) {
      throw new Error(`Shadow projection version ${this.shadowVersion} is missing`);
    }

    let ingested = 0;
    let duplicatesSkipped = 0;

    const sorted = [...batch].sort((a, b) => {
      if (a.ledger !== b.ledger) return a.ledger - b.ledger;
      return a.eventIndex - b.eventIndex;
    });

    for (const record of sorted) {
      const recordKey = `${record.ledger}_${record.txHash}_${record.eventIndex}`;
      if (shadow.events.has(recordKey)) {
        duplicatesSkipped++;
        continue;
      }
      if (!this.supportedSchemas.has(record.schemaVersion)) {
        console.warn(`Encountered unsupported event schema version: ${record.schemaVersion}`);
      }
      shadow.events.set(recordKey, { ...record, id: recordKey });
      ingested++;

      if (record.ledger > shadow.cursor.lastLedger ||
         (record.ledger === shadow.cursor.lastLedger && record.eventIndex > shadow.cursor.lastEventIndex)) {
        shadow.cursor = {
          lastLedger: record.ledger,
          lastEventIndex: record.eventIndex,
          updatedAt: Date.now(),
        };
      }
    }

    shadow.meta.eventCount = shadow.events.size;
    shadow.meta.checksum = computeChecksum(shadow.events.values());

    return { ingested, duplicatesSkipped };
  }

  /**
   * Validate the shadow projection against the source (active) projection.
   * Compares event counts and checksums. On failure the shadow is marked
   * 'failed' and the active projection is left untouched.
   */
  public validateShadow(): { valid: boolean; reason?: string } {
    if (this.shadowVersion === null) {
      throw new Error('No rebuild in progress; call beginRebuild() first');
    }
    const shadow = this.projections.get(this.shadowVersion);
    if (!shadow) {
      throw new Error(`Shadow projection version ${this.shadowVersion} is missing`);
    }
    const active = this.getActive();

    const shadowChecksum = computeChecksum(shadow.events.values());
    const activeChecksum = computeChecksum(active.events.values());

    if (shadow.events.size !== active.events.size) {
      shadow.meta.status = 'failed';
      return {
        valid: false,
        reason: `event count mismatch: shadow=${shadow.events.size} active=${active.events.size}`,
      };
    }
    if (shadowChecksum !== activeChecksum) {
      shadow.meta.status = 'failed';
      return {
        valid: false,
        reason: `checksum mismatch: shadow=${shadowChecksum} active=${activeChecksum}`,
      };
    }

    shadow.meta.checksum = shadowChecksum;
    shadow.meta.eventCount = shadow.events.size;
    shadow.meta.status = 'validated';
    return { valid: true };
  }

  /**
   * Atomically flip the active projection pointer to the validated shadow.
   * Throws (leaving the active projection untouched) if validation has not
   * succeeded.
   */
  public commitSwap(): ProjectionVersion {
    if (this.shadowVersion === null) {
      throw new Error('No rebuild in progress; call beginRebuild() first');
    }
    const shadow = this.projections.get(this.shadowVersion);
    if (!shadow) {
      throw new Error(`Shadow projection version ${this.shadowVersion} is missing`);
    }
    if (shadow.meta.status !== 'validated') {
      throw new Error(`Cannot swap: shadow version ${shadow.meta.version} is not validated (status=${shadow.meta.status})`);
    }

    const previousActive = this.activeVersion;
    shadow.meta.status = 'active';
    this.activeVersion = shadow.meta.version;
    this.shadowVersion = null;

    const prev = this.projections.get(previousActive);
    if (prev) {
      prev.meta.status = 'failed';
    }

    return { ...shadow.meta };
  }

  /**
   * Abort an in-progress rebuild, discarding the shadow projection.
   */
  public abortRebuild(): void {
    if (this.shadowVersion === null) return;
    const shadow = this.projections.get(this.shadowVersion);
    if (shadow) {
      shadow.meta.status = 'failed';
    }
    this.projections.delete(this.shadowVersion);
    this.shadowVersion = null;
  }

  /**
   * Expose bounded, stably ordered queries.
   */
  public queryEvents(params: {
    contractId?: string;
    fromLedger?: number;
    toLedger?: number;
    limit?: number;
  }): SorobanEventRecord[] {
    const { contractId, fromLedger = 0, toLedger = Infinity, limit = 50 } = params;
    const results: SorobanEventRecord[] = [];
    const active = this.getActive();

    for (const record of active.events.values()) {
      if (contractId && record.contractId !== contractId) continue;
      if (record.ledger < fromLedger || record.ledger > toLedger) continue;
      results.push(record);
    }

    return results
      .sort((a, b) => {
        if (a.ledger !== b.ledger) return a.ledger - b.ledger;
        return a.eventIndex - b.eventIndex;
      })
      .slice(0, Math.min(limit, 100));
  }
}

/**
 * Deterministic checksum over a set of event records, independent of
 * insertion order. Used to compare shadow and active projections.
 */
function computeChecksum(records: Iterable<SorobanEventRecord>): string {
  const keys: string[] = [];
  for (const record of records) {
    keys.push(record.id);
  }
  keys.sort();
  let hash = 0x811c9dc5;
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
