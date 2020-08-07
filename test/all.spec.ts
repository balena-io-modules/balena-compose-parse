import { assert, expect } from 'chai';
import * as yml from 'js-yaml';
import * as utils from './utils';

import * as compose from '../src';

['1.0', '2.0', '2.1'].forEach((version) => {
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

describe('default composition', () => {
	it('with build context', (done) => {
		const composeStr = compose.defaultComposition();
		const composeJson = yml.safeLoad(composeStr, {
			schema: yml.FAILSAFE_SCHEMA,
		});
		const c = compose.normalize(composeJson);
		expect(c.version).to.equal('2.1');
		expect(compose.parse(c)).to.deep.equal([
			{ serviceName: 'main', image: { context: '.' } },
		]);
		done();
	});

	it('with build dockerfile name', (done) => {
		const composeStr = compose.defaultComposition(undefined, 'MyDockerfile');
		const composeJson = yml.safeLoad(composeStr, {
			schema: yml.FAILSAFE_SCHEMA,
		});
		const c = compose.normalize(composeJson);
		expect(c.version).to.equal('2.1');
		expect(compose.parse(c)).to.deep.equal([
			{
				serviceName: 'main',
				image: { context: '.', dockerfile: 'MyDockerfile' },
			},
		]);
		done();
	});

	it('with image', (done) => {
		const composeStr = compose.defaultComposition('some/image');
		const composeJson = yml.safeLoad(composeStr, {
			schema: yml.FAILSAFE_SCHEMA,
		});
		const c = compose.normalize(composeJson);
		expect(c.version).to.equal('2.1');
		expect(compose.parse(c)).to.deep.equal([
			{ serviceName: 'main', image: 'some/image' },
		]);
		done();
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
		expect(c.services.s1.depends_on).to.deep.equal(['s3']);
		expect(c.services.s2.depends_on).to.deep.equal(['s1', 's3']);
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

	it('parses ports converting numbers to strings', (done) => {
		expect(c.services.s3.ports).to.deep.equal([
			'1000',
			'1001:1002',
			'1003:1004/tcp',
		]);
		done();
	});

	it('normalizes extra_hosts from objects or arrays', (done) => {
		expect(c.services.s2.extra_hosts).to.deep.equal(['foo:127.0.0.1']);
		expect(c.services.s3.extra_hosts).to.deep.equal(['bar:8.8.8.8']);
		done();
	});

	it('networks', (done) => {
		expect(c.networks).to.deep.equal({
			n1: {},
			n2: {},
		});
		done();
	});

	it('volumes', (done) => {
		expect(c.volumes).to.deep.equal({
			v1: {},
			v2: {},
		});
		done();
	});
});

describe('validation', () => {
	it('should raise if label name contains forbidden characters', (done) => {
		const f = () => {
			compose.normalize({
				version: '2.1',
				services: {
					main: {
						image: 'some/image',
						labels: {
							mal_formed: 'true',
						},
					},
				},
			});
		};
		expect(f).to.throw('Invalid label name: "mal_formed"');
		done();
	});

	it('should fail if a relative bind mount is specified', () => {
		const f = () => {
			compose.normalize({
				version: '2.1',
				services: {
					main: {
						image: 'some/image',
						volumes: ['./localPath:/some-place'],
					},
				},
			});
		};
		expect(f).to.throw('Bind mounts are not allowed');
	});

	it('should fail if an absolute bind mount is specified', () => {
		const f = () => {
			compose.normalize({
				version: '2.1',
				services: {
					main: {
						image: 'some/image',
						volumes: ['/localPath:/some-place'],
					},
				},
			});
		};
		expect(f).to.throw('Bind mounts are not allowed');
	});

	it('should fail with an invalid volume definition', () => {
		const f = () => {
			compose.normalize({
				version: '2.1',
				services: {
					main: {
						image: 'some/image',
						volumes: ['thisIsNotAValidVolume'],
					},
				},
			});
		};
		expect(f).to.throw("Invalid volume: 'thisIsNotAValidVolume'");
	});

	it('should fail if a volume definition is missing', () => {
		const f = () => {
			compose.normalize({
				version: '2.1',
				services: {
					main: {
						image: 'some/image',
						volumes: ['someVolume:/some-place'],
					},
				},
				volumes: {
					someOtherVolume: {},
				},
			});
		};
		expect(f).to.throw("Missing volume definition for 'someVolume'");
	});

	it('should not fail if a port matches the ports regex', () => {
		const f = () => {
			compose.normalize({
				version: '2.1',
				services: {
					main: {
						image: 'some/image',
						ports: ['1002:1003/tcp'],
					},
				},
			});
		};
		expect(f).to.not.throw();
	});

	it("should fail if a port doesn't match the ports regex", () => {
		const f = () => {
			compose.normalize({
				version: '2.1',
				services: {
					main: {
						image: 'some/image',
						ports: ['1002:1003/tc'],
					},
				},
			});
		};
		expect(f).to.throw(
			'data/services/main/ports/0 should match format "ports"',
		);
	});

	it('should not fail if a volume definition is present', () => {
		const data = {
			version: '2.1',
			services: {
				main: {
					image: 'some/image',
					volumes: ['someVolume:/some-place'],
				},
			},
			volumes: {
				someVolume: {},
			},
		};
		const f = () => {
			compose.normalize(data);
		};
		expect(f).to.not.throw();
	});
});
