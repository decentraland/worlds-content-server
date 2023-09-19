declare module '@ensdomains/eth-ens-namehash' {
  export function hash(ensName: string): string;
  export function normalize(name: string): string;
}
