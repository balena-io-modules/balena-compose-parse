import { Readable } from 'stream';
import * as _ from 'lodash';
import * as path from 'path';

import { InternalInconsistencyError, ValidationError } from './errors';
import {
	DEFAULT_SCHEMA_VERSION,
	SchemaError,
	SchemaVersion,
	validate,
} from './schemas';
import {
	BuildConfig,
	Composition,
	Dict,
	ImageDescriptor,
	ListOrDict,
	Network,
	Service,
	StringOrList,
	Volume,
} from './types';

// tslint:disable-next-line
const packageJson = require('../package.json');
const packageVersion = packageJson.version;

export function defaultComposition(
	image?: string,
	dockerfile?: string,
): string {
	let context: string;
	if (image) {
		context = `image: ${image}`;
	} else {
		if (dockerfile) {
			context = `build: {context: ".", dockerfile: "${dockerfile}"}`;
		} else {
			context = 'build: "."';
		}
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
    tty: true
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
 * @param inputCompositionObject The input composition as a plain JS object
 */
export function normalize(inputCompositionObject: any): Composition;

/**
 * Validates, normalises and returns the input composition. If the composition
 * does not have the expected structure and discrepancies can't be resolved,
 * validation errors are thrown. The input composition is mutated in-place.
 *
 * The context for the composition is the project directory which contains the composition
 * and describes additional context for the composition. E.g. environment varialbe files
 * This context is read and expanded into the composition.
 *
 * To access this context (files) a callback function fileResolverCb is needed as argument,
 * that reads a filePath:string and creates an promisfied Readable from this file.
 * Callback has to validate that no symbolic links are used outside project folder.
 * Using on filesystem files it should call fs.realpath to validate the filePath.
 * Using a tar archive which contains the file should add additional validation for
 * the file resinding in the archive (e.g. symbolic links by default are references in
 * tar archives)
 *
 * Drops env_file propertie from composition to indicate that the expand has taken place.
 *
 * @param inputCompositionObject The input composition as a plain JS object
 * @param fileResolverCb Callback to access filePath and returning a Readable
 * Callback tries to read the filePath as file and create a Readable for it.
 */
export async function normalize(
	inputCompositionObject: any,
	fileResolverCb: (path: string) => Promise<Readable>,
): Promise<Composition>;
export function normalize(
	inputCompositionObject: any,
	fileResolverCb?: (path: string) => Promise<Readable>,
): Composition | Promise<Composition> {
	if (fileResolverCb === undefined) {
		return normalizeObjectToComposition(inputCompositionObject);
	} else {
		const composition = normalizeObjectToComposition(inputCompositionObject);
		return expandContext(composition, fileResolverCb);
	}
}

function normalizeObjectToComposition(
	inputCompositionObject: any,
): Composition {
	if (!_.isObject(inputCompositionObject)) {
		throw new ValidationError('Invalid composition format');
	}

	let version: SchemaVersion;
	let c = inputCompositionObject as {
		version: any;
		[key: string]: any;
	};

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

	preflight(version, c);

	try {
		validate(version, c);
	} catch (e) {
		if (e instanceof SchemaError) {
			throw new ValidationError(e);
		}
		throw e;
	}

	switch (version) {
		case SchemaVersion.v1_0:
			c = { version: SchemaVersion.v2_0, services: c };
		// FIXME: perform attribute migration
		case SchemaVersion.v2_0:
			c.version = SchemaVersion.v2_1;
		/* no attributes migration needed for 2.0->2.1 */
		case SchemaVersion.v2_1:
			// Normalise volumes
			if (c.volumes) {
				const volumes: Dict<Volume> = c.volumes;
				c.volumes = _.mapValues(volumes, normalizeVolume);
			}

			// Normalise services
			const services: Dict<Service> = c.services || {};
			const serviceNames = _.keys(services);
			const volumeNames = _.keys(c.volumes);

			c.services = _.mapValues(services, (service) => {
				return normalizeService(service, serviceNames, volumeNames);
			});

			// Normalise networks
			if (c.networks) {
				const networks: Dict<Network> = c.networks;
				c.networks = _.mapValues(networks, normalizeNetwork);
			}

			return c as Composition;
	}
}

function preflight(_version: SchemaVersion, data: any) {
	// Convert `null` networks to empty objects
	if (_.isObject(data.networks)) {
		data.networks = _.mapValues(data.networks, (n) => n || {});
	}

	// Convert `null` volumes to empty objects
	if (_.isObject(data.volumes)) {
		data.volumes = _.mapValues(data.volumes, (v) => v || {});
	}
}

function normalizeService(
	service: Service,
	serviceNames: string[],
	volumeNames: string[],
): Service {
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

	if (service.env_file) {
		service.env_file = normalizeAndValidateFilePath(service.env_file);
	}

	if (service.extra_hosts) {
		if (!_.isArray(service.extra_hosts)) {
			// At this point we know that the extra_hosts entry is an object, so cast to
			// keep TS happy
			service.extra_hosts = normalizeExtraHostObject(
				service.extra_hosts as any,
			);
		}
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
	_.keys(labels).forEach((name) => {
		if (!/^[a-zA-Z0-9.-]+$/.test(name)) {
			throw new ValidationError(
				`Invalid label name: "${name}". ` +
					'Label names must only contain alphanumeric ' +
					'characters, periods "." and dashes "-".',
			);
		}
	});
}

function normalizeNetwork(network: Network): Network {
	if (network.labels) {
		network.labels = normalizeKeyValuePairs(network.labels);
		validateLabels(network.labels);
	}
	return network;
}

function normalizeVolume(volume: Volume): Volume {
	if (volume.labels) {
		volume.labels = normalizeKeyValuePairs(volume.labels);
		validateLabels(volume.labels);
	}
	return volume;
}

function normalizeExtraHostObject(extraHostsObject: Dict<string>): string[] {
	return _.map(extraHostsObject, (ip, host) => `${host}:${ip}`);
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
	return _.toPairs(c.services).map(([name, service]) => {
		return createImageDescriptor(name, service);
	});
}

function createImageDescriptor(
	serviceName: string,
	service: Service,
): ImageDescriptor {
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

function normalizeKeyValuePairs(
	obj?: ListOrDict,
	sep: string = '=',
): Dict<string> {
	if (!obj) {
		return {};
	}
	if (!_.isArray(obj)) {
		return _(obj)
			.toPairs()
			.map(([key, value]) => {
				return [key, value ? ('' + value).trim() : ''];
			})
			.fromPairs()
			.value();
	}
	return _(obj)
		.map((val) => {
			const parts = val.split(sep);
			return [parts.shift()!, parts.join('=')];
		})
		.map(([key, value]) => {
			return [key.trim(), value ? value.trim() : ''];
		})
		.fromPairs()
		.value();
}

function normalizeAndValidateFilePath(envFile: StringOrList): StringOrList {
	// use a set to store only unique normalized file paths
	const normalizedEnvFilePaths: Set<string> = new Set();
	if (!Array.isArray(envFile)) {
		envFile = [envFile];
	}
	for (let envFilePath of envFile) {
		envFilePath = path.normalize(envFilePath);
		if (path.isAbsolute(envFilePath)) {
			throw new ValidationError(
				`Absolute filepath not allowed: ${envFilePath}`,
			);
		}
		if (envFilePath.startsWith('..')) {
			throw new ValidationError(
				`Directory traversing not allowed : ${envFilePath}`,
			);
		}
		if (envFilePath.includes('*')) {
			throw new ValidationError(`Wildcards not allowed : ${envFilePath}`);
		}
		normalizedEnvFilePaths.add(envFilePath);
	}
	// spread set and return as array
	return [...normalizedEnvFilePaths];
}

async function expandContext(
	composition: Composition,
	fileResolverCb: (path: string) => Promise<Readable>,
): Promise<Composition> {
	// read all env_file delcared file paths from the composition
	const expandedEnvironmentFiles: Dict<Dict<string>> =
		await readEnvFilesFromComposition(composition, fileResolverCb);
	// assign all normalized envrionment variables to the services in the composition
	assignExpandedEnvFilesToComposition(composition, expandedEnvironmentFiles);
	return composition;
}

async function readEnvFilesFromComposition(
	composition: Composition,
	fileResolverCb: (path: string) => Promise<Readable>,
): Promise<Dict<Dict<string>>> {
	const envFileVariables: Dict<Dict<string>> = {};
	for (const service of Object.values(composition.services)) {
		let envFilePaths = service.env_file;
		if (!!envFilePaths) {
			if (!Array.isArray(envFilePaths)) {
				envFilePaths = [envFilePaths];
			}
			for (const envFilePath of envFilePaths) {
				if (!(envFilePath in envFileVariables)) {
					envFileVariables[envFilePath] = await readAndNormalizeExpandEnvFile(
						envFilePath,
						fileResolverCb,
					);
				}
			}
		}
	}
	return envFileVariables;
}

function assignExpandedEnvFilesToComposition(
	composition: Composition,
	envFileVariables: Dict<Dict<string>>,
): Composition {
	// Apply all read env_files content to the services referncing the env_files
	for (const service of Object.values(composition.services)) {
		let envFilePaths = service.env_file;
		if (!!envFilePaths) {
			service.environment = service.environment ?? {};
			if (!Array.isArray(envFilePaths)) {
				envFilePaths = [envFilePaths];
			}
			for (const envFilePath of envFilePaths) {
				for (const [key, value] of Object.entries(
					envFileVariables[envFilePath],
				)) {
					if (!(key in service.environment)) {
						service.environment[key] = value;
					}
				}
			}
		}
		// delete the env_file property as it has been translated into composition environments
		delete service.env_file;
	}
	return composition;
}

async function readAndNormalizeExpandEnvFile(
	envFile: string,
	fileResolverCb: (path: string) => Promise<Readable>,
): Promise<Dict<string>> {
	const readline = require('readline');
	const { once } = require('events');
	const intermediateEnv: Dict<string> = {};
	let readableError;

	// instantiate readable from callback to add eventlistener to it
	const readable = await fileResolverCb(envFile);
	const lineReader = readline.createInterface({
		input: readable,
		crlfDelay: Infinity,
	});

	// get error from  stream reader and close linereader
	// no race condition as the lineReader is paused until an event listener is registered
	readable.on('error', (readError) => {
		readableError = readError;
		lineReader.close();
	});

	// process each line on event
	// now readable will be evaluated
	// read all lines in a buffer dictionary to later merge them into existing environment
	lineReader.on('line', (line: string) => {
		for (const [key, val] of Object.entries(normalizeKeyValuePairs([line]))) {
			intermediateEnv[key] = val;
		}
	});

	// wait until all lines read or stream error occured
	await once(lineReader, 'close');

	// populate stream errors
	if (readableError !== undefined) {
		throw readableError;
	}

	return intermediateEnv;
}
