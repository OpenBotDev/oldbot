# openbot

Sniperbot on Solana

Roadmap

* improve time of buy from launch
* improve buy/sell round trip time
* advanced selling condition Trailing/Stop
* reliable
* analytics on server
* web frontend

## install

```
sudo apt update -y
curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | sudo apt-key add -
echo "deb https://dl.yarnpkg.com/debian/ stable main" | sudo tee /etc/apt/sources.list.d/yarn.list
sudo apt update -y
sudo apt install yarn -y
git clone git@github.com:OpenBotDev/sniperbot.git && cd sniperbot
yarn install
sudo apt install curl unzip -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
yarn install
cp .env.copy .env
```

## run

```yarn run bot```
