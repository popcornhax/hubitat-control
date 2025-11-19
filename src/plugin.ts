import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { HubitatControl } from "./actions/hubitat-control";

// Verbose logging while we’re developing
//streamDeck.logger.setLevel(LogLevel.TRACE);

// Verbose logging while we’re developing
streamDeck.logger.setLevel(LogLevel.ERROR);


// Register our Hubitat control action
streamDeck.actions.registerAction(new HubitatControl());

// Finally, connect to the Stream Deck.
streamDeck.connect();