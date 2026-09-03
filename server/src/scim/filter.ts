/**
 * The subset of SCIM filters (RFC 7644 §3.4.2.2) that provisioning clients
 * use to look a resource up before creating it: one `attribute eq "value"`
 * clause. Okta sends `userName eq "…"` and `displayName eq "…"`.
 */
export interface ScimFilter {
  attribute: string;
  value: string;
}

export class ScimFilterError extends Error {}

export function parseFilter(raw: string | undefined): ScimFilter | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const m = /^\s*([A-Za-z][\w.:-]*)\s+(\w+)\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(raw);
  if (!m) throw new ScimFilterError(`The filter "${raw}" is not supported. Use the form: attribute eq "value".`);
  const [, attribute, op, value] = m;
  if (op!.toLowerCase() !== "eq") throw new ScimFilterError(`The filter operator "${op}" is not supported; only eq is.`);
  return { attribute: attribute!.replace(/^urn:ietf:params:scim:schemas:core:2\.0:(User|Group):/i, ""), value: value!.replace(/\\(.)/g, "$1") };
}
