import { assert, expect } from 'chai';
import * as utils from './utils';

import * as compose from '../src';

const images = [
	{ serviceName: 's1', image: { context: './' } },
	{ serviceName: 's2', image: 'some/image' },
];

[ '1.0', '2.0', '2.1' ].forEach((version) => {
	describe(`v${version}`, () => {
		const composition = utils.loadFixture(`test-v${version}.json`);

		it('should migrate composition to default version', (done) => {
			expect(compose.normalize(composition).version).to.equal('2.1');
			done();
		});

		it('should parse composition services', (done) => {
			const c = compose.normalize(composition);
			const d = compose.parse(c);
			expect(d).to.deep.equal(images);
			done();
		});
	});
});
