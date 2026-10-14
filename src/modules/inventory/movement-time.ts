import { z } from "zod";
import { BadRequestError } from "../../utils/errors";
export const movementTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a valid time").optional();
// School event time is entered in IST. Keep recording time as a separate audit field.
export function occurredAt(date: string, time?: string) {
 return time ? new Date(`${date}T${time}:00+05:30`) : null;
}
export function checkEventOrder(issue: { occurredAt?: Date | null; recordedOn: Date }, date: string, time?: string) {
 const actual = occurredAt(date, time);
 if (date < issue.recordedOn.toISOString().slice(0, 10) || (actual && issue.occurredAt && actual < issue.occurredAt)) throw new BadRequestError("Event date and time cannot be before the issue date and time");
}
