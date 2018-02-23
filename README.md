# git-mango-helper

Git remote helper for [Mango](https://github.com/axic/mango).

## Install

The package now uses an external IPFS node instead of one created from inside the code. Installing an IPFS node is fairly easy:

```
npm install -g ipfs
```

Then simply install `git-mango-helper` **globally**.

```
npm install -g git-mango-helper
```

This will install the `git-remote-mango` executable which will be used by git to support the `mango://` protocol.

## Usage

First, make sure you have an IPFS node running.

```
jsipfs daemon
```

Then simply use git normally with a mango address: 

```
git pull mango://0x890fe361f9ede4ad40a3cac75877f9cd1183e0ab
```



## License

GPL v3

Copyright (C) 2016 Alex Beregszaszi


Some of this code is based on snippets from https://github.com/clehner/memory-pull-git-repo:

Copyright (c) 2016 Charles Lehner

Usage of the works is permitted provided that this instrument is retained with the works, so that any entity that uses the works is notified of this instrument.

DISCLAIMER: THE WORKS ARE WITHOUT WARRANTY.
