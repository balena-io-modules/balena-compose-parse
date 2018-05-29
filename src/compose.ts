import * as _ from 'lodash';
import * as path from 'path';

import { InternalInconsistencyError, ValidationError } from './errors';
import { DEFAULT_SCHEMA_VERSION, SchemaError, SchemaVersion, validate } from './schemas';
import { BuildConfig, Composition, Dict, ImageDescriptor, ListOrDict, Network, Service, Volume } from './types';

// tslint:disable-next-line
const packageJson = require('../package.json');
const packageVersion = packageJson.version;

export function defaultComposition(image?: string): string {
	let context: string;
	if (image) {
		context = `image: ${image}`;
	} else {
		context = 'build: "."';
	}
	return `# Auto-generated compose file by resin-compose-parse@v${packageVersion}
version: '2.1'
networks: {}
volumes:
  resin-data: {}
services:
  main:
    ${context}
    privileged: true
    restart: always
    network_mode: host
    volumes:
      - resin-data:/data
    labels:
      io.resin.features.kernel-modules: 1
      io.resin.features.firmware: 1
      io.resin.features.dbus: 1
      io.resin.features.supervisor-api: 1
      io.resin.features.resin-api: 1
`;
}

/**
 * Validates, normalises and returns the input composition. If the composition
 * does not have the expected structure and discrepancies can't be resolved,
 * validation errors are thrown. The input composition is mutated in-place.
 *
 * @param c The input composition as a plain JS object
 */
export function normalize(c: any): Composition {
	if (!_.isObject(c)) {
		throw new ValidationError('Invalid composition format');
	}

	let version: SchemaVersion;

	if (_.isUndefined(c.version)) {
		version = SchemaVersion.v1_0;
	} else {
		if (!_.isString(c.version)) {
			c.version = `${c.version}`;
		}
		switch (c.version) {
			case '2':
			case '2.0':
			version = SchemaVersion.v2_0;
			break;
		case '2.1':
			version = SchemaVersion.v2_1;
			break;
		default:
			throw new ValidationError('Unsupported composition version');
		}
	}

	try {
		validate(version, c);
	} catch (e) {
		if (e instanceof SchemaError) {
			throw new ValidationError(e);
		}
		throw e;
	}

	while (true) {
		switch (version) {
		case SchemaVersion.v1_0:
			version = SchemaVersion.v2_0;
			c = { version, services: c };
			// FIXME: perform attribute migration
			break;
		case SchemaVersion.v2_0:
			version = SchemaVersion.v2_1;
			c.version = version;
			/* no attributes migration needed for 2.0->2.1 */
			break;
		case SchemaVersion.v2_1:
			// Normalise volumes
			if (c.volumes) {
				const volumes: Dict<Volume | null> = c.volumes;
				c.volumes = _.mapValues(volumes, normalizeVolume);
			}

			// Normalise services
			const services: Dict<Service> = c.services || { };
			const serviceNames = _.keys(services);
			const volumeNames = _.keys(c.volumes);

			c.services = _.mapValues(services, (service) => {
				return normalizeService(service, serviceNames, volumeNames);
			});

			// Normalise networks
			if (c.networks) {
				const networks: Dict<Network | null> = c.networks;
				c.networks = _.mapValues(networks, normalizeNetwork);
			}

			return c;
		}
	}
}

function normalizeService(service: Service, serviceNames: string[], volumeNames: string[]): Service {
	if (!service.image && !service.build) {
		throw new ValidationError('You must specify either an image or a build');
	}

	if (service.build) {
		if (_.isString(service.build)) {
			service.build = { context: service.build };
		}
		if (service.build.args) {
			service.build.args = normalizeKeyValuePairs(service.build.args);
		}
		if (service.build.labels) {
			service.build.labels = normalizeKeyValuePairs(service.build.labels);
			validateLabels(service.build.labels);
		}
	}

	if (service.depends_on) {
		if (!_.isArray(service.depends_on)) {
			throw new ValidationError('Service dependencies must be an array');
		}
		if (_.uniq(service.depends_on).length !== service.depends_on.length) {
			throw new ValidationError('Service dependencies must be unique');
		}
		service.depends_on.forEach((dep) => {
			if (!_.includes(serviceNames, dep)) {
				throw new ValidationError(`Unknown service dependency: ${dep}`);
			}
		});
	}

	if (service.environment) {
		service.environment = normalizeKeyValuePairs(service.environment);
	}

	if (service.extra_hosts) {
		service.extra_hosts = normalizeKeyValuePairs(service.extra_hosts, ':');
	}

	if (service.labels) {
		service.labels = normalizeKeyValuePairs(service.labels);
		validateLabels(service.labels);
	}

	if (service.ports) {
		service.ports = normalizeArrayOfStrings(service.ports);
	}

	if (service.volumes) {
		service.volumes.forEach((volume) => {
			validateServiceVolume(volume, volumeNames);
		});
	}

	return service;
}

function normalizeArrayOfStrings(value: any[]): string[] {
	return _.map(value, String);
}

function validateServiceVolume(serviceVolume: string, volumeNames: string[]) {
	const colonIndex = serviceVolume.indexOf(':');
	if (colonIndex === -1) {
		throw new ValidationError(`Invalid volume: '${serviceVolume}'`);
	}
	const source = serviceVolume.slice(0, colonIndex);
	if (path.parse(source).dir !== '') {
		throw new ValidationError('Bind mounts are not allowed');
	}
	if (volumeNames.indexOf(source) === -1) {
		throw new ValidationError(`Missing volume definition for '${source}'`);
	}
}

function validateLabels(labels: Dict<string>) {
	_.keys(labels).forEach(name => {
		if (!/^[a-zA-Z0-9.-]+$/.test(name)) {
			throw new ValidationError(
				`Invalid label name: "${name}". ` +
				'Label names must only contain alphanumeric ' +
				'characters, periods "." and dashes "-".');
		}
	});
}

function normalizeNetwork(network?: Network): Network | null {
	if (!network) {
		return null;
	}

	if (network.labels) {
		network.labels = normalizeKeyValuePairs(network.labels);
		validateLabels(network.labels);
	}

	return network;
}

function normalizeVolume(volume?: Volume): Volume | null {
	if (!volume) {
		return null;
	}

	if (volume.labels) {
		volume.labels = normalizeKeyValuePairs(volume.labels);
		validateLabels(volume.labels);
	}

	return volume;
}

/**
 * Parses a composition and returns a list of image descriptors that can
 * be used to pull or build a service image. The given composition version
 * must be equal to `DEFAULT_SCHEMA_VERSION`, or an exception is thrown.
 * Normalise the composition before passing it to this function.
 */
export function parse(c: Composition): ImageDescriptor[] {
	if (c.version !== DEFAULT_SCHEMA_VERSION) {
		throw new Error('Unsupported composition version');
	}
	return _.toPairs(c.services).map(([ name, service ]) => {
		return createImageDescriptor(name, service);
	});
}

function createImageDescriptor(serviceName: string, service: Service): ImageDescriptor {
	if (service.image && !service.build) {
		return { serviceName, image: service.image };
	}

	if (!service.build) {
		// should not get here
		throw new InternalInconsistencyError();
	}

	const build: BuildConfig = {
		context: service.build.context,
	};

	if (service.build.dockerfile) {
		build.dockerfile = service.build.dockerfile;
	}
	if (service.build.args) {
		build.args = service.build.args;
	}
	if (service.build.labels) {
		build.labels = service.build.labels;
	}
	if (service.image) {
		build.tag = service.image;
	}

	return { serviceName, image: build };
}

function normalizeKeyValuePairs(obj?: ListOrDict, sep: string = '='): Dict<string> {
	if (!obj) {
		return {};
	}
	if (!_.isArray(obj)) {
		return _(obj)
			.toPairs()
			.map(([ key, value ]) => {
				return [ key, value ? ('' + value).trim() : '' ];
			})
			.fromPairs()
			.value();
	}
	return _(obj)
		.map(val => {
			const parts = val.split(sep);
			return [ parts.shift()!, parts.join('=') ];
		})
		.map(([ key, value ]) => {
			return [ key.trim(), value ? value.trim() : '' ];
		})
		.fromPairs()
		.value();
}
