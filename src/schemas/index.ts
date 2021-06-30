import * as fs from 'fs';

import Ajv04 from 'ajv-draft-04';
// import Ajv2019 from 'ajv/dist/2019';
import { TypedError } from 'typed-error';

export class SchemaError extends TypedError {}

export enum SchemaVersion {
	v1_0 = '',
	v2_0 = '2',
	v2_1 = '2.1',
}

export const DEFAULT_SCHEMA_VERSION = SchemaVersion.v2_1;

const schemas: any = {};
schemas[SchemaVersion.v1_0] = 'v1';
schemas[SchemaVersion.v2_0] = 'v2.0';
schemas[SchemaVersion.v2_1] = 'v2.1';

function loadJSON(path: string): any {
	const filePath = require.resolve(path);
	const buf = fs.readFileSync(filePath);
	return JSON.parse(buf.toString('utf-8'));
}

function loadSchema(version: SchemaVersion): any {
	return loadJSON(`./config_schema_${schemas[version]}.json`);
}

export function validate(version: SchemaVersion, data: any): void {
	const schema = loadSchema(version);

	let validator;
	switch (version) {
		case SchemaVersion.v1_0:
		case SchemaVersion.v2_0:
		case SchemaVersion.v2_1:
		case SchemaVersion.v3:
			validator = new Ajv04({
				allErrors: false,
				coerceTypes: true,
				jsonPointers: true,
				logger: false,
				schemaId: 'id',
				useDefaults: true,
				strict: false,
			} as any); // cast to `any` required because ajv declarations omit `logger`.
			break;

		// case SchemaVersion.v3:
		// 	validator = new Ajv2019({
		// 		allErrors: false,
		// 		coerceTypes: true,
		// 		logger: false,
		// 		useDefaults: false,
		// 	});
		// 	break;

		default:
			throw new Error('unknown schema version');
	}

	validator
		.addFormat('ports', validatePorts)
		.addFormat('expose', validateExpose)
		.addFormat('duration', validateDuration)
		.addFormat('subnet_ip_address', validateSubnetIpAddress);

	if (!validator.validate(schema, data)) {
		throw new SchemaError(
			`Validating ${schema.schema}: ${validator.errorsText()}`,
		);
	}
}

function validatePorts(value: string): boolean {
	return /^(?:(?:([a-fA-F\d.:]+):)?([\d]*)(?:-([\d]+))?:)?([\d]+)(?:-([\d]+))?(?:\/(udp|tcp))?$/.test(
		value,
	);
}

function validateExpose(value: string | number): boolean {
	return /^\d+(\-\d+)?(\/[a-zA-Z]+)?$/.test(`${value}`);
}

function validateDuration(value: string | number): boolean {
	if (typeof value === 'number') {
		return true;
	}

	const re = new RegExp(
		'^' +
			'(?:([\\d.]+)h)?' +
			'(?:([\\d.]+)m)?' +
			'(?:([\\d.]+)s)?' +
			'(?:([\\d.]+)ms)?' +
			'(?:([\\d.]+)us)?' +
			'(?:([\\d.]+)ns)?' +
			'$',
	);

	return re.test(value);
}
