import { assert, expect } from 'chai';
import * as utils from './utils';

import * as compose from '../src';

[ '1.0', '2.0', '2.1' ].forEach((version) => {
	const services = [
		{ serviceName: 's1', image: { context: './' } },
		{ serviceName: 's2', image: 'some/image' },
	];

	describe(`v${version}`, () => {
		it('should migrate composition to default version', (done) => {
			const composition = utils.loadFixture(`test-v${version}.json`);
			expect(compose.normalize(composition).version).to.equal('2.1');
			done();
		});

		it('should parse composition services', (done) => {
			const composition = utils.loadFixture(`test-v${version}.json`);
			const c = compose.normalize(composition);
			const d = compose.parse(c);
			expect(d).to.deep.equal(services);
			done();
		});
	});
});

describe('normalization', () => {
	const composition = utils.loadFixture('default.json');
	const c = compose.normalize(composition);

	it('should migrate composition to default version', (done) => {
		expect(c.version).to.equal('2.1');
		done();
	});

	it('should parse composition services', (done) => {
		expect(compose.parse(c)).to.deep.equal([
			{ serviceName: 's1', image: { context: './s1' } },
			{ serviceName: 's2', image: { context: './s2' } },
			{ serviceName: 's3', image: 'some/image' },
		]);
		done();
	});

	it('depends_on', (done) => {
		expect(c.services.s1.depends_on).to.deep.equal({
			s3: { condition: 'service_started' },
		});
		expect(c.services.s2.depends_on).to.deep.equal({
			s1: { condition: 'service_started' },
			s3: { condition: 'service_started' },
		});
		done();
	});

	it('environment', (done) => {
		expect(c.services.s1.environment).to.deep.equal({
			SOME_VAR: 'some=value',
		});
		expect(c.services.s2.environment).to.deep.equal({
			SOME_VAR: 'some value',
		});
		done();
	});
});
