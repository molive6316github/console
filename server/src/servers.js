import { ID, listServers } from "./db.js";
import { getDriver, driverTypes } from "./drivers/index.js";
import { TargetError } from "./drivers/exec.js";

export class InputError extends Error {}

// Checks what the web form sent and returns a clean row. Throws InputError with a message fit for the user.
export function validateServerInput(body, { requireId = true } = {}) {
  const b = body ?? {};
  const out = {};
  if (requireId) {
    if (typeof b.id !== "string" || !ID.test(b.id)) throw new InputError("ID must be lowercase letters, numbers and dashes (for example survival-smp)");
    out.id = b.id;
  }
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 80) throw new InputError("Give it a name (up to 80 characters)");
  out.name = name;
  if (!driverTypes.includes(b.type)) throw new InputError(`Type must be one of: ${driverTypes.join(", ")}`);
  out.type = b.type;
  if (typeof b.target !== "object" || b.target === null || Array.isArray(b.target)) throw new InputError("Target settings are required");
  try {
    out.target = getDriver(b.type).validate(b.target);
  } catch (e) {
    if (e instanceof TargetError) throw new InputError(e.message);
    throw e;
  }
  return out;
}

export function idTaken(db, id) {
  return listServers(db).some((s) => s.id === id);
}
