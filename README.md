# Worlds Content Server

[![Coverage Status](https://coveralls.io/repos/github/decentraland/worlds-content-server/badge.svg)](https://coveralls.io/github/decentraland/worlds-content-server)


This is a simple content server API needed to deploy and retrieve scenes.

It uses the `@dcl/catalyst-storage` library to store the deployments either on the disk or S3.


# Running a Worlds Content Server
## For development
For development purposes, just clone this repository, build the project and 
run:
```bash
git clone https://github.com/decentraland/worlds-content-server.git
yarn
yarn build
yarn start
```
There should be a server running on port 3000.

## For production
For running a production server, it is recommended to use the docker image 
published by this repository. It is important to provide proper values for 
LiveKit configuration using `--env` CLI options, as follows:
```bash
docker pull quay.io/decentraland/worlds-content-server
docker run --name wcs -p 3000:3000 --env COMMS_ADAPTER=livekit --env LIVEKIT_HOST=<your livekit url> --env LIVEKIT_API_KEY=<your api key> --env LIVEKIT_API_SECRET=<your secret>  quay.io/decentraland/worlds-content-server
```

# Deploying entities to this server

For a deployment to be accepted by this server, the wallet deploying must own a DCL name.

The scene must specify the name of the world in `scene.json`, and that DCL name must be owned by the wallet signing the deployment.

For more details on deploying scenes please check out [the documentation](https://docs.decentraland.org/creator/worlds/about/#publish-a-world).


## Deploying using the CLI tool

Once your signer address is added to the allow-list, then you should be able to deploy to this server. The recommended approach is by the CLI tool. You must specify the URL of this server as `--content-server` to make it work, like this:

```bash
# cd into your scene
cd my-scene

# then deploy
export DCL_PRIVATE_KEY=0x....
dcl deploy --target-content https://worlds-content-server.decentraland.org
```

Upon successful deployment, the latest version of the CLI should print some helpful information about how to preview the scene along with the addressable URN of the deployment.

### Addressable URN

A deployment in Decentraland can live anywhere as long as it complies with the format. To consistently identify deployments and their location in servers, the concept of addressable URN is introduced.

Let a valid deployment URN be:
```
urn:decentraland:entity:bafkreihpipyhrt75xyquwrynrtjadwb373xfosy7a5rhlh5vogjajye3im
```

That deployment will be downloaded from the configured content server by default. But for testing purposes, the content servers are not always the most straight forward way to test. To help the operations, a baseUrl query parameter can be added: `?baseUrl=https://worlds-content-server.decentraland.org/contents/` yielding a full URN like this:

```
urn:decentraland:entity:bafkreihpipyhrt75xyquwrynrtjadwb373xfosy7a5rhlh5vogjajye3im?=&baseUrl=https://worlds-content-server.decentraland.org/contents/
```

Now the explorers know where to look for when downloading that entity, bypassing the content servers. Or more precisely, pointing to this server which acts as content server.

# Using Addressable URNs

As of the moment of writing this document, there are two ways to use the addressable URNs: as global portable experiences and as single scene instead of loading the genesis city.

The first one is used to generate experiences for all users, like the pride event calendar. It can be tested by adding the `GLOBAL_PX=<urn>` query parameter to the explorer. Like this https://play.decentraland.zone/?GLOBAL_PX=urn:decentraland:entity:bafkreihpipyhrt75xyquwrynrtjadwb373xfosy7a5rhlh5vogjajye3im?=&baseUrl=https://worlds-content-server.decentraland.org/contents/

The second use case is to load a singular scene instead of the full genesis city. Likewise, it is done via adding a `SPACE=<urn>` query parameter, like this: https://play.decentraland.zone/?SPACE=urn:decentraland:entity:bafkreihpipyhrt75xyquwrynrtjadwb373xfosy7a5rhlh5vogjajye3im?=&baseUrl=https://worlds-content-server.decentraland.org/contents/

Portable experiences and single scenes (spaces) can be used at the same time to generate dynamic experiences.

These flows are designed to improve the user experience in the areas like onboarding experiences, helper calendars for events, and for debugging purposes among others.

## 🤖 AI Agent Context

**Service Purpose:** Content server specifically for Decentraland Worlds (named scenes). Enables deployment and retrieval of world scenes that are identified by DCL names rather than parcel coordinates. Supports global portable experiences and single-scene loading.

**Key Capabilities:**

- Stores and serves World entity deployments (scenes associated with DCL names)
- Validates deployment ownership (deployer must own the DCL name in scene.json)
- Provides content retrieval API for world scenes
- Supports addressable URNs for global portable experiences and single-scene loading
- Uses @dcl/catalyst-storage for entity storage (disk or S3)

**Communication Pattern:** Synchronous HTTP REST API

**Technology Stack:**

- Runtime: Node.js
- Language: TypeScript
- HTTP Framework: @well-known-components/http-server
- Storage: @dcl/catalyst-storage (entity content storage)
- Component Architecture: @well-known-components (logger, metrics, http-server)

**External Dependencies:**

- Database: PostgreSQL (world metadata, permissions, blocked wallets)
- Storage: Local disk or AWS S3 (via @dcl/catalyst-storage)
- Blockchain: DCL Names ownership validation (deployer must own name)
- Communication: LiveKit (optional, for comms adapter configuration)

**Database Schema:** See [docs/database-schema.md](docs/database-schema.md) for complete database schema documentation including tables, columns, indexes, permissions structure, and migration history.

**Key Concepts:**

- **World**: A scene identified by a DCL name rather than parcel coordinates
- **Addressable URN**: Entity URN format enabling global portable experiences and single-scene loading
- **Global Portable Experience**: Experiences loaded for all users (via GLOBAL_PX query parameter)
- **Single Scene**: Load a specific scene instead of Genesis City (via SPACE query parameter)

**Deployment Requirements:**

- Deployer wallet must own the DCL name specified in scene.json
- World name in scene.json must match owned DCL name

**Database Schema:**

- **Tables**: `worlds` (world deployments, permissions, metadata), `blocked` (blocked wallets), `migrations` (migration tracking)
- **Key Columns**: `worlds.name` (PK), `worlds.entity_id`, `worlds.permissions` (JSON), `worlds.owner`, `worlds.size`
- **Permissions**: Stored as JSON with `deployment`, `access`, and `streaming` settings (allow-list, unrestricted, shared-secret, NFT ownership)
- **Full Documentation**: See [docs/database-schema.md](docs/database-schema.md) for detailed schema, column definitions, example queries, and migration history
