import mongoose, { Schema, type Types } from "mongoose";

/**
 * Where the latest-records email has got to. One document, `_id: "state"`.
 *
 * The cursors are the last record each collection's email covered, by `_id`.
 * The loader writes every new or changed record as a new document, so its
 * `_id` says when it reached Sanction Search, whatever its source dates say.
 * A cursor only moves once an email has been queued, so a failed send leaves
 * its records for the next try.
 */
export interface ILatestRecordsAlertState {
  _id: string;
  sanctionsCursor: Types.ObjectId;
  pepCursor: Types.ObjectId;
  /** When the first email's records start: a day before the job first ran. */
  coversFrom: Date;
  /** The 15:00 slot the last email was sent for. */
  lastDailySlot?: Date;
  lastDailySentAt?: Date;
}

const stateSchema = new Schema<ILatestRecordsAlertState>(
  {
    _id: { type: String, required: true },
    sanctionsCursor: { type: Schema.Types.ObjectId, required: true },
    pepCursor: { type: Schema.Types.ObjectId, required: true },
    coversFrom: { type: Date, required: true },
    lastDailySlot: Date,
    lastDailySentAt: Date,
  },
  { timestamps: true, versionKey: false },
);

export const LatestRecordsAlertStateModel = mongoose.model<ILatestRecordsAlertState>(
  "LatestRecordsAlertState",
  stateSchema,
  "sanctionlatestrecordsalertstate",
);

/** One row per email queued: what went, to whom. */
export interface ILatestRecordsAlertSend {
  toEmails: string[];
  since: Date;
  sentAt: Date;
  sanctions: number;
  pep: number;
  other: number;
  workbookKey?: string;
  /** Linked rather than attached: too large for an email. */
  workbookLinked: boolean;
}

const sendSchema = new Schema<ILatestRecordsAlertSend>(
  {
    toEmails: { type: [String], default: [] },
    since: { type: Date, required: true },
    sentAt: { type: Date, required: true },
    sanctions: { type: Number, required: true },
    pep: { type: Number, required: true },
    other: { type: Number, required: true },
    workbookKey: String,
    workbookLinked: { type: Boolean, default: false },
  },
  { versionKey: false },
);

sendSchema.index({ sentAt: -1 });

export const LatestRecordsAlertSendModel = mongoose.model<ILatestRecordsAlertSend>(
  "LatestRecordsAlertSend",
  sendSchema,
  "sanctionlatestrecordsalertsends",
);
