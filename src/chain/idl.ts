import bs58 from "bs58";

export type IdlType =
  | string
  | { vec: IdlType }
  | { option: IdlType }
  | { coption: IdlType }
  | { array: [IdlType, number] }
  | { defined: { name: string } | string };

export interface IdlField {
  name: string;
  type: IdlType;
}

export interface IdlTypeDef {
  name: string;
  type:
    | { kind: "struct"; fields?: Array<IdlField | IdlType> }
    | { kind: "enum"; variants: Array<{ name: string; fields?: Array<IdlField | IdlType> }> };
}

export interface IdlEventDef {
  name: string;
  discriminator: number[];
}

export interface Idl {
  address: string;
  types?: IdlTypeDef[];
  events?: IdlEventDef[];
}

export class TruncatedDataError extends Error {
  constructor() {
    super("truncated data");
  }
}

export class BorshReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  get position(): number {
    return this.offset;
  }

  remaining(): number {
    return this.buffer.length - this.offset;
  }

  private take(length: number): Buffer {
    if (this.offset + length > this.buffer.length) {
      throw new TruncatedDataError();
    }
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  u8(): number {
    return this.take(1).readUInt8(0);
  }

  i8(): number {
    return this.take(1).readInt8(0);
  }

  u16(): number {
    return this.take(2).readUInt16LE(0);
  }

  i16(): number {
    return this.take(2).readInt16LE(0);
  }

  u32(): number {
    return this.take(4).readUInt32LE(0);
  }

  i32(): number {
    return this.take(4).readInt32LE(0);
  }

  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }

  i64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }

  u128(): bigint {
    const slice = this.take(16);
    return slice.readBigUInt64LE(0) + (slice.readBigUInt64LE(8) << 64n);
  }

  i128(): bigint {
    const slice = this.take(16);
    const low = slice.readBigUInt64LE(0);
    const high = slice.readBigInt64LE(8);
    return (high << 64n) + low;
  }

  f32(): number {
    return this.take(4).readFloatLE(0);
  }

  f64(): number {
    return this.take(8).readDoubleLE(0);
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  pubkey(): string {
    return bs58.encode(this.take(32));
  }

  bytes(): Buffer {
    const length = this.u32();
    return Buffer.from(this.take(length));
  }

  string(): string {
    return this.bytes().toString("utf8");
  }
}

export type DecodedValue =
  | number
  | bigint
  | boolean
  | string
  | Buffer
  | null
  | DecodedValue[]
  | { [key: string]: DecodedValue };

export interface DecodedStruct {
  fields: Record<string, DecodedValue>;
  complete: boolean;
  trailingBytes: number;
}

export class IdlCoder {
  private readonly types = new Map<string, IdlTypeDef>();

  constructor(idl: Idl) {
    for (const typeDef of idl.types ?? []) {
      this.types.set(typeDef.name, typeDef);
    }
  }

  hasType(name: string): boolean {
    return this.types.has(name);
  }

  decodeStructPrefix(typeName: string, data: Buffer): DecodedStruct {
    const typeDef = this.types.get(typeName);
    if (!typeDef || typeDef.type.kind !== "struct") {
      throw new Error(`unknown struct type ${typeName}`);
    }
    const reader = new BorshReader(data);
    const fields: Record<string, DecodedValue> = {};
    const defs = typeDef.type.fields ?? [];
    let complete = true;
    for (let index = 0; index < defs.length; index += 1) {
      const def = defs[index];
      if (def === undefined) {
        continue;
      }
      const named = isNamedField(def);
      const name = named ? def.name : String(index);
      const type = named ? def.type : def;
      try {
        fields[name] = this.decodeType(type, reader);
      } catch (error) {
        if (error instanceof TruncatedDataError) {
          complete = false;
          break;
        }
        throw error;
      }
    }
    return { fields, complete, trailingBytes: reader.remaining() };
  }

  decodeType(type: IdlType, reader: BorshReader): DecodedValue {
    if (typeof type === "string") {
      return this.decodePrimitive(type, reader);
    }
    if ("vec" in type) {
      const length = reader.u32();
      if (length > reader.remaining()) {
        throw new TruncatedDataError();
      }
      const values: DecodedValue[] = [];
      for (let i = 0; i < length; i += 1) {
        values.push(this.decodeType(type.vec, reader));
      }
      return values;
    }
    if ("option" in type) {
      return reader.u8() === 0 ? null : this.decodeType(type.option, reader);
    }
    if ("coption" in type) {
      const tag = reader.u32();
      return tag === 0 ? null : this.decodeType(type.coption, reader);
    }
    if ("array" in type) {
      const [inner, length] = type.array;
      if (inner === "u8") {
        const values: DecodedValue[] = [];
        for (let i = 0; i < length; i += 1) {
          values.push(reader.u8());
        }
        return values;
      }
      const values: DecodedValue[] = [];
      for (let i = 0; i < length; i += 1) {
        values.push(this.decodeType(inner, reader));
      }
      return values;
    }
    if ("defined" in type) {
      const name = typeof type.defined === "string" ? type.defined : type.defined.name;
      return this.decodeDefined(name, reader);
    }
    throw new Error(`unsupported idl type ${JSON.stringify(type)}`);
  }

  private decodeDefined(name: string, reader: BorshReader): DecodedValue {
    const typeDef = this.types.get(name);
    if (!typeDef) {
      throw new Error(`unknown defined type ${name}`);
    }
    if (typeDef.type.kind === "struct") {
      const defs = typeDef.type.fields ?? [];
      if (defs.length > 0 && defs.every((def) => !isNamedField(def))) {
        const values = defs.map((def) => this.decodeType(def as IdlType, reader));
        return values.length === 1 ? (values[0] ?? null) : values;
      }
      const result: Record<string, DecodedValue> = {};
      for (const def of defs) {
        if (isNamedField(def)) {
          result[def.name] = this.decodeType(def.type, reader);
        }
      }
      return result;
    }
    const variantIndex = reader.u8();
    const variant = typeDef.type.variants[variantIndex];
    if (!variant) {
      throw new Error(`invalid enum variant ${variantIndex} for ${name}`);
    }
    if (!variant.fields || variant.fields.length === 0) {
      return variant.name;
    }
    const payload: Record<string, DecodedValue> = {};
    variant.fields.forEach((def, index) => {
      if (isNamedField(def)) {
        payload[def.name] = this.decodeType(def.type, reader);
      } else {
        payload[String(index)] = this.decodeType(def, reader);
      }
    });
    return { [variant.name]: payload };
  }

  private decodePrimitive(type: string, reader: BorshReader): DecodedValue {
    switch (type) {
      case "bool":
        return reader.bool();
      case "u8":
        return reader.u8();
      case "i8":
        return reader.i8();
      case "u16":
        return reader.u16();
      case "i16":
        return reader.i16();
      case "u32":
        return reader.u32();
      case "i32":
        return reader.i32();
      case "u64":
        return reader.u64();
      case "i64":
        return reader.i64();
      case "u128":
        return reader.u128();
      case "i128":
        return reader.i128();
      case "f32":
        return reader.f32();
      case "f64":
        return reader.f64();
      case "pubkey":
      case "publicKey":
        return reader.pubkey();
      case "string":
        return reader.string();
      case "bytes":
        return reader.bytes();
      default:
        throw new Error(`unsupported primitive ${type}`);
    }
  }
}

function isNamedField(def: IdlField | IdlType): def is IdlField {
  return typeof def === "object" && def !== null && "name" in def && "type" in def;
}

export interface EventDecoder {
  programId: string;
  decode(data: Buffer): { name: string; decoded: DecodedStruct } | null;
}

export function createEventDecoder(idl: Idl): EventDecoder {
  const coder = new IdlCoder(idl);
  const byDiscriminator = new Map<string, string>();
  for (const event of idl.events ?? []) {
    if (coder.hasType(event.name)) {
      byDiscriminator.set(Buffer.from(event.discriminator).toString("hex"), event.name);
    }
  }
  return {
    programId: idl.address,
    decode(data: Buffer) {
      if (data.length < 8) {
        return null;
      }
      const name = byDiscriminator.get(data.subarray(0, 8).toString("hex"));
      if (!name) {
        return null;
      }
      return { name, decoded: coder.decodeStructPrefix(name, data.subarray(8)) };
    }
  };
}
