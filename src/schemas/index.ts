import * as fs from 'fs';

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

export function getSchema(version: SchemaVersion): any {
	const fileVersion = schemas[version];
	const filePath = require.resolve(`./config_schema_${fileVersion}.json`);
	const buf = fs.readFileSync(filePath);
	return JSON.parse(buf.toString('utf-8'));
}
