import { assert, expect } from 'chai';
import * as yml from 'js-yaml';
import * as utils from './utils';

import * as compose from '../src';
import { Dict } from '../src/types';

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

describe('default composition', () => {
	it('with build context', (done) => {
		const composeStr = compose.defaultComposition();
		const composeJson = yml.safeLoad(composeStr, { schema: yml.FAILSAFE_SCHEMA });
		const c = compose.normalize(composeJson);
		expect(c.version).to.equal('2.1');
		expect(compose.parse(c)).to.deep.equal([
			{ serviceName: 'main', image: { context: '.' } },
		]);
		done();
	});

	it('with image', (done) => {
		const composeStr = compose.defaultComposition('some/image');
		const composeJson = yml.safeLoad(composeStr, { schema: yml.FAILSAFE_SCHEMA });
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
		expect(c.services.s1.depends_on).to.deep.equal([
			's3',
		]);
		expect(c.services.s2.depends_on).to.deep.equal([
			's1',
			's3',
		]);
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
		expect(c.services.s3.ports).to.deep.equal([ '1000', '1001:1002', '1003:1004/tcp' ]);
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
						volumes: [
							'./localPath:/some-place',
						],
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
						volumes: [
							'/localPath:/some-place',
						],
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
						volumes: [
							'thisIsNotAValidVolume',
						],
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
						volumes: [
							'someVolume:/some-place',
						],
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
						ports: [
							'1002:1003/tcp',
						],
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
						ports: [
							'1002:1003/tc',
						],
					},
				},
			});
		};
		expect(f).to.throw('data/services/main/ports/0 should match format "ports"');
	});

	it('should not fail if a volume definition is present', () => {
		const data = {
			version: '2.1',
			services: {
				main: {
					image: 'some/image',
					volumes: [
						'someVolume:/some-place',
					],
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

describe('interpolation', () => {
	const testEnvironment = (kv: Dict<string>) => {
		const composition = compose.normalize({
			version: '2.1',
			services: {
				main: {
					image: 'some/image',
					environment: kv,
				},
			},
		}, {
			VAR: 'var_value',
			EMPTY_VAR: '',
		});
		return composition.services.main.environment as Dict<string>;
	};

	const cases: Array<[ string, string, string ]> = [
		[ 'escaped', '$$VAR', '$VAR' ],
		[ 'escaped', '$$$VAR', '$$VAR' ],
		[ 'escaped', '$$$$VAR', '$$$VAR' ],
		[ 'escaped', '$${VAR}', '${VAR}' ],
		[ 'escaped', '$$${VAR}', '$${VAR}' ],
		[ 'escaped', '$$$${VAR}', '$$${VAR}' ],

		[ 'trivial substitution', '$VAR', 'var_value' ],
		[ 'trivial substitution', '${VAR}', 'var_value' ],
		[ 'trivial substitution', '$EMPTY_VAR', '' ],
		[ 'trivial substitution', '${EMPTY_VAR}', '' ],
		[ 'trivial substitution', '$UNDEFINED_VAR', '' ],
		[ 'trivial substitution', '${UNDEFINED_VAR}', '' ],

		[ 'ignores default if no braces', '$VAR-notadefault', 'var_value-notadefault' ],
		[ 'ignores default if no braces', '$VAR:-notadefault', 'var_value:-notadefault' ],
		[ 'ignores default if no braces', '$VAR?notanerror', 'var_value?notanerror' ],
		[ 'ignores default if no braces', '$VAR:?notanerror', 'var_value:?notanerror' ],
		[ 'ignores default if no braces', '$VAR-notadefault 1_^C#$-r', 'var_value-notadefault 1_^C#$-r' ],
		[ 'ignores default if no braces', '$VAR:-notadefault 1_^C#$-r', 'var_value:-notadefault 1_^C#$-r' ],
		[ 'ignores default if no braces', '$VAR?notanerror 1_^C#$-r', 'var_value?notanerror 1_^C#$-r' ],
		[ 'ignores default if no braces', '$VAR:?notanerror 1_^C#$-r', 'var_value:?notanerror 1_^C#$-r' ],
		[ 'ignores default if no braces', '$EMPTY_VAR-notadefault', '-notadefault' ],
		[ 'ignores default if no braces', '$EMPTY_VAR:-notadefault', ':-notadefault' ],
		[ 'ignores default if no braces', '$EMPTY_VAR?notanerror', '?notanerror' ],
		[ 'ignores default if no braces', '$EMPTY_VAR:?notanerror', ':?notanerror' ],
		[ 'ignores default if no braces', '$EMPTY_VAR-notadefault 1_^C#$-r', '-notadefault 1_^C#$-r' ],
		[ 'ignores default if no braces', '$EMPTY_VAR:-notadefault 1_^C#$-r', ':-notadefault 1_^C#$-r' ],
		[ 'ignores default if no braces', '$EMPTY_VAR?notanerror 1_^C#$-r', '?notanerror 1_^C#$-r' ],
		[ 'ignores default if no braces', '$EMPTY_VAR:?notanerror 1_^C#$-r', ':?notanerror 1_^C#$-r' ],
		[ 'ignores default if no braces', '$UNDEFINED_VAR-notadefault', '-notadefault' ],
		[ 'ignores default if no braces', '$UNDEFINED_VAR:-notadefault', ':-notadefault' ],
		[ 'ignores default if no braces', '$UNDEFINED_VAR?notanerror', '?notanerror' ],
		[ 'ignores default if no braces', '$UNDEFINED_VAR:?notanerror', ':?notanerror' ],
		[ 'ignores default if no braces', '$UNDEFINED_VAR-notadefault 1_^C#$-r', '-notadefault 1_^C#$-r' ],
		[ 'ignores default if no braces', '$UNDEFINED_VAR:-notadefault 1_^C#$-r', ':-notadefault 1_^C#$-r' ],
		[ 'ignores default if no braces', '$UNDEFINED_VAR?notanerror 1_^C#$-r', '?notanerror 1_^C#$-r' ],
		[ 'ignores default if no braces', '$UNDEFINED_VAR:?notanerror 1_^C#$-r', ':?notanerror 1_^C#$-r' ],

		[ '`-` uses default if undefined', '${VAR-default}', 'var_value' ],
		[ '`-` uses default if undefined', '${VAR-default 1_^C#$-r}', 'var_value' ],
		[ '`-` uses default if undefined', '${EMPTY_VAR-default}', '' ],
		[ '`-` uses default if undefined', '${EMPTY_VAR-default 1_^C#$-r}', '' ],
		[ '`-` uses default if undefined', '${UNDEFINED_VAR-default}', 'default' ],
		[ '`-` uses default if undefined', '${UNDEFINED_VAR-default 1_^C#$-r}', 'default 1_^C#$-r' ],

		[ '`:-` uses default if undefined or empty', '${VAR:-default}', 'var_value' ],
		[ '`:-` uses default if undefined or empty', '${VAR:-default 1_^C#$-r}', 'var_value' ],
		[ '`:-` uses default if undefined or empty', '${EMPTY_VAR:-default}', 'default' ],
		[ '`:-` uses default if undefined or empty', '${EMPTY_VAR:-default 1_^C#$-r}', 'default 1_^C#$-r' ],
		[ '`:-` uses default if undefined or empty', '${UNDEFINED_VAR:-default}', 'default' ],
		[ '`:-` uses default if undefined or empty', '${UNDEFINED_VAR:-default 1_^C#$-r}', 'default 1_^C#$-r' ],

		[ '`?` throws if undefined', '${VAR?error}', 'var_value' ],
		[ '`?` throws if undefined', '${VAR?error 1_^C#$-r}', 'var_value' ],
		[ '`?` throws if undefined', '${EMPTY_VAR?error}', '' ],
		[ '`?` throws if undefined', '${EMPTY_VAR?error 1_^C#$-r}', '' ],

		[ '`:?` throws if undefined or empty', '${VAR?error}', 'var_value' ],
		[ '`:?` throws if undefined or empty', '${VAR?error 1_^C#$-r}', 'var_value' ],
	];

	const throwingCases: Array<[ string, string, string ]> = [
		[ '`?` throws if undefined', '${UNDEFINED_VAR?error}', 'error' ],
		[ '`?` throws if undefined', '${UNDEFINED_VAR?error 1_^C#$-r}', 'error 1_^C#$-r' ],

		[ '`:?` throws if undefined or empty', '${EMPTY_VAR:?error}', 'error' ],
		[ '`:?` throws if undefined or empty', '${EMPTY_VAR:?error 1_^C#$-r}', 'error 1_^C#$-r' ],
		[ '`:?` throws if undefined or empty', '${UNDEFINED_VAR:?error}', 'error' ],
		[ '`:?` throws if undefined or empty', '${UNDEFINED_VAR:?error 1_^C#$-r}', 'error 1_^C#$-r' ],
	];

	const makeComplex = (n, a, b): [ string, string, string ] => {
		return [
			n,
			`pre$$fix${a} in$$fix${a} su$$ffix`,
			`pre$fix${b} in$fix${b} su$ffix`,
		];
	};

	for (const test of cases) {
		const [ name, value, result ] = test;
		it(`${name}: ${value}`, (done) => {
			expect(testEnvironment({ prop: value })).to.deep.equal({ prop: result });
			done();
		});
	}

	for (const test of throwingCases) {
		const [ name, value, err ] = test;
		it(`${name}: ${value}`, (done) => {
			const f = () => {
				testEnvironment({ prop: value });
			};
			expect(f).to.throw(err);
			done();
		});
	}

	for (const test of cases) {
		const [ name, value, result ] = makeComplex(...test);
		it(`complex: ${name}: ${value}`, (done) => {
			expect(testEnvironment({ prop: value })).to.deep.equal({ prop: result });
			done();
		});
	}
});
