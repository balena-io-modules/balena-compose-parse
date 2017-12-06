import * as fs from 'fs';
import * as path from 'path';

export function loadFixture(filename: string): any {
	const p = path.join(__dirname, 'fixtures', filename);
	const buf = fs.readFileSync(p);
	return JSON.parse(buf.toString('utf-8'));
}
