type Schema = Record<string, any>

const typeOf = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  return typeof value
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const validate = (
  value: unknown,
  schema: Schema,
  path: string,
  errors: string[],
): void => {
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((branch: Schema) => {
      const branchErrors: string[] = []
      validate(value, branch, path, branchErrors)
      return branchErrors
    })
    if (!attempts.some((branchErrors: string[]) => branchErrors.length === 0)) {
      errors.push(`${path}: no anyOf branch matched`)
    }
    return
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in the enum`)
  }

  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    const matches =
      expected.includes(actual) || (actual === "integer" && expected.includes("number"))
    if (!matches) {
      errors.push(`${path}: expected ${expected.join(" | ")}, got ${actual}`)
    }
  }

  if (schema.type === "object" || schema.properties) {
    if (!isObject(value)) {
      if (schema.type) errors.push(`${path}: expected an object`)
      return
    }
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}.${key}: missing required property`)
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validate(value[key], child as Schema, `${path}.${key}`, errors)
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key)) {
          errors.push(`${path}.${key}: unexpected property`)
        }
      }
    }
  }

  if (schema.type === "array" || schema.items) {
    if (!Array.isArray(value)) {
      if (schema.type) errors.push(`${path}: expected an array`)
      return
    }
    value.forEach((item, index) => {
      validate(item, schema.items as Schema, `${path}[${index}]`, errors)
    })
  }
}

export const validateSchema = (value: unknown, schema: unknown): string[] => {
  const errors: string[] = []
  validate(value, schema as Schema, "$", errors)
  return errors
}
