// Wall-clock date/time helpers shared by the Schedule page and the Bracket
// Setup wizard's Courts / Start-time steps, so there is one implementation
// of the datetime-local round-trip and the time label (D-0049).

// `<input type="datetime-local">` expects "YYYY-MM-DDTHH:MM" in **local**
// time with no timezone suffix. Going either direction:
//   - toLocalInput: ISO/timestamptz → local-time slug for the input
//   - fromLocalInput: local-time slug → ISO with the browser's offset
// Both round-trip the same wall-clock moment the organizer sees.
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(local: string): string | null {
  if (!local) return null;
  // new Date("YYYY-MM-DDTHH:MM") parses as local time in browsers, then
  // .toISOString() gives us the UTC-equivalent storage form.
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
