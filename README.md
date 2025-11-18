# Worlds Content Server

[![Coverage Status](https://coveralls.io/repos/github/decentraland/worlds-content-server/badge.svg?branch=main)](https://coveralls.io/github/decentraland/worlds-content-server?branch=main)

Content server specifically for Decentraland Worlds (named scenes). Enables deployment and retrieval of world scenes that are identified by DCL names rather than parcel coordinates. Supports global portable experiences and single-scene loading.

This server interacts with DCL Names (ENS) for ownership validation, LiveKit for communications, and AWS S3 for content storage in order to provide users with the ability to deploy and manage isolated 3D scenes outside of Genesis City.

## Table of Contents

- [Worlds Content Server](#worlds-content-server)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Dependencies \& Related Services](#dependencies--related-services)
  - [API Documentation](#api-documentation)
  - [Database Schema](#database-schema)
  - [Getting Started](#getting-started)
    - [Prerequisites](#prerequisites)
    - [Installation](#installation)
    - [Configuration](#configuration)
    - [Running the Service](#running-the-service)
      - [Setting up the environment](#setting-up-the-environment)
      - [Running in development mode](#running-in-development-mode)
      - [Running in production mode](#running-in-production-mode)
  - [Deploying Entities](#deploying-entities)
    - [Deploying using the CLI tool](#deploying-using-the-cli-tool)
    - [Addressable URNs](#addressable-urns)
    - [Using Addressable URNs](#using-addressable-urns)
  - [Testing](#testing)
    - [Running Tests](#running-tests)
    - [Test Structure](#test-structure)
  - [How to Contribute](#how-to-contribute)
  - [License](#license)
  - [AI Agent Context](#ai-agent-context)

## Features

- **World Deployment**: Deploy and manage 3D scenes linked to Decentraland NAMEs (ENS or DCL domains)
- **Access Control**: Configure granular permissions for deployment, access, and streaming (allow-list, unrestricted, shared-secret, NFT ownership)
- **Content Storage**: Store and retrieve scene assets via IPFS-compatible content addressing using `@dcl/catalyst-storage` (disk or S3)
- **Addressable URNs**: Support for global portable experiences and single-scene loading via addressable URN format
- **Ownership Validation**: Validates that deployer wallet owns the DCL name specified in scene.json
- **Live Data**: Real-time information about active worlds and connected users
- **Communications Service**: Built-in communications adapter integration (LiveKit, WebRTC)

## Dependencies & Related Services

This service interacts with the following services:

- **[Catalyst](https://github.com/decentraland/catalyst)**: Uses similar entity storage patterns and validation logic
- **[DCL Names/ENS](https://ens.domains/)**: Validates ownership of DCL names for deployment authorization
- **[LiveKit](https://livekit.io/)**: Optional communications adapter for multi-user experiences
- **[AWS SNS](https://aws.amazon.com/sns/)**: Publishes deployment notifications

External dependencies:

- **PostgreSQL**: Database for world metadata, permissions, and blocked wallets
- **NATS**: Message broker for internal event handling
- **AWS S3** (optional): Cloud storage backend via `@dcl/catalyst-storage`
- **Local Disk Storage** (default): File system storage via `@dcl/catalyst-storage`

## API Documentation

The API is fully documented using the [OpenAPI standard](https://swagger.io/specification/). Its schema is located at [docs/openapi.yaml](docs/openapi.yaml).

## Database Schema

See [docs/database-schema.md](docs/database-schema.md) for detailed schema, column definitions, and relationships.

## Getting Started

### Prerequisites

Before running this service, ensure you have the following installed:

- **Node.js**: Version 22.x or higher (LTS recommended)
- **Yarn**: Version 1.22.x or higher
- **Docker**: For containerized deployment and local development dependencies
- **PostgreSQL**: Version 14+ (or use Docker Compose)

### Installation

1. Clone the repository:

```bash
git clone https://github.com/decentraland/worlds-content-server.git
cd worlds-content-server
```

2. Install dependencies:

```bash
yarn install
```

3. Build the project:

```bash
yarn build
```

### Configuration

The service uses environment variables for configuration.

Create a `.env` file in the root directory containing the environment variables for the service to run. Key configuration variables include:

- `DATABASE_URL`: PostgreSQL connection string
- `STORAGE_ROOT_FOLDER`: Local storage path (or S3 configuration)
- `LIVEKIT_HOST`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`: LiveKit configuration (optional)
- `COMMS_ADAPTER`: Communication adapter type (`livekit` or `native`)
- `ETH_NETWORK`: Ethereum network (`mainnet` or `sepolia`)

For a complete list of configuration options, check the service's environment configuration in `src/components.ts`.

### Running the Service

#### Setting up the environment

In order to successfully run this server, external dependencies such as databases, message brokers, and storage must be provided.

To do so, this repository provides you with a `docker-compose.yml` file for that purpose. In order to get the environment set up, run:

```bash
docker-compose up -d
```

This will start:
- PostgreSQL database on port `5450`
- NATS message broker on port `4222`

#### Running in development mode

To run the service in development mode:

```bash
yarn dev
```

This will:
- Watch for file changes
- Automatically rebuild TypeScript
- Restart the server on changes

#### Running in production mode

For production deployment, use the Docker image:

```bash
docker pull quay.io/decentraland/worlds-content-server
docker run --name wcs -p 3000:3000 \
  --env COMMS_ADAPTER=livekit \
  --env LIVEKIT_HOST=<your livekit url> \
  --env LIVEKIT_API_KEY=<your api key> \
  --env LIVEKIT_API_SECRET=<your secret> \
  quay.io/decentraland/worlds-content-server
```

## Deploying Entities

For a deployment to be accepted by this server, the wallet deploying must own a DCL name. The scene must specify the name of the world in `scene.json`, and that DCL name must be owned by the wallet signing the deployment.

For more details on deploying scenes, please check out [the documentation](https://docs.decentraland.org/creator/worlds/about/#publish-a-world).

### Deploying using the CLI tool

Once your signer address owns a DCL name, you can deploy to this server using the CLI tool:

```bash
# cd into your scene
cd my-scene

# then deploy
export DCL_PRIVATE_KEY=0x....
dcl deploy --target-content https://worlds-content-server.decentraland.org
```

Upon successful deployment, the latest version of the CLI should print some helpful information about how to preview the scene along with the addressable URN of the deployment.

### Addressable URNs

A deployment in Decentraland can live anywhere as long as it complies with the format. To consistently identify deployments and their location in servers, the concept of addressable URN is introduced.

Let a valid deployment URN be:
```
urn:decentraland:entity:bafkreihpipyhrt75xyquwrynrtjadwb373xfosy7a5rhlh5vogjajye3im
```

That deployment will be downloaded from the configured content server by default. But for testing purposes, a baseUrl query parameter can be added: `?baseUrl=https://worlds-content-server.decentraland.org/contents/` yielding a full URN like this:

```
urn:decentraland:entity:bafkreihpipyhrt75xyquwrynrtjadwb373xfosy7a5rhlh5vogjajye3im?=&baseUrl=https://worlds-content-server.decentraland.org/contents/
```

### Using Addressable URNs

There are two ways to use addressable URNs:

1. **Global Portable Experiences**: Generate experiences for all users (e.g., event calendars)
   - Test by adding `GLOBAL_PX=<urn>` query parameter to the explorer
   - Example: `https://play.decentraland.zone/?GLOBAL_PX=urn:decentraland:entity:...?=&baseUrl=https://worlds-content-server.decentraland.org/contents/`

2. **Single Scene Loading**: Load a specific scene instead of the full Genesis City
   - Test by adding `SPACE=<urn>` query parameter
   - Example: `https://play.decentraland.zone/?SPACE=urn:decentraland:entity:...?=&baseUrl=https://worlds-content-server.decentraland.org/contents/`

Portable experiences and single scenes (spaces) can be used at the same time to generate dynamic experiences.

## Testing

This service includes comprehensive test coverage with both unit and integration tests.

### Running Tests

Run all tests with coverage:

```bash
yarn test
```

Run tests in watch mode:

```bash
yarn test --watch
```

Run only unit tests:

```bash
yarn test test/unit
```

Run only integration tests:

```bash
yarn test test/integration
```

### Test Structure

- **Unit Tests** (`test/unit/`): Test individual components and functions in isolation
- **Integration Tests** (`test/integration/`): Test the complete request/response cycle

For detailed testing guidelines and standards, refer to our [Testing Standards](https://github.com/decentraland/docs/tree/main/development-standards/testing-standards) documentation.

## How to Contribute

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request


- `feat`: A new feature (bumps minor version)
- `fix`: A bug fix (bumps patch version)
- `docs`: Documentation only changes (bumps patch version)
- `style`: Code style changes (formatting, missing semi colons, etc.) (bumps patch version)
- `refactor`: Code refactoring without feature changes or bug fixes (bumps patch version)
- `test`: Adding or updating tests (bumps patch version)
- `chore`: Maintenance tasks, dependency updates, etc. (bumps patch version)
- `revert`: Reverts a previous commit (bumps patch version)
- `break`: Breaking changes (bumps major version)

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

## AI Agent Context

For detailed AI Agent context, see [docs/ai-agent-context.md](docs/ai-agent-context.md).
