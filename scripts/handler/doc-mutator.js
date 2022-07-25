import {Mutation} from "../entity/mutation.mjs";
import {logger} from "../utility/logger.js";
import {MODULE} from "../utility/module.js";
import {Mutator} from "./mutator.js";
import {MutationStack, StackData} from "../entity/mutation-stack.js"

const NAME = "DocMutator";

export class DocMutator {
  static register() {
    Hooks.once("ready", () => {
      globalThis.DocMutator = DocMutator;
      globalThis.Mutation = Mutation;
    });
  }

  /**
   * @param {Mutation} mutation
   */
  static async apply(mutation) {
    logger.debug("Mutate Info", mutation);

    let callbackRet = {};

    /* premutate callback */
    const preRet = await Promise.all(
      mutation.callAll(Mutation.STAGE.PRE_MUTATE)
    );

    /* can be cancelled, if so, bail */
    if (preRet.some((ret) => ret === false)) return false;
    callbackRet[Mutation.STAGE.PRE_MUTATE] = preRet;

    const embedRet = await DocMutator._updateEmbedded(mutation);
    const docRet = await DocMutator._updateDocument(mutation);

    /* post mutate callback (no cancel to be had) */
    callbackRet[Mutation.STAGE.POST_MUTATE] = await Promise.all(
      mutation.callAll(Mutation.STAGE.POST_MUTATE)
    );

    return { doc: docRet, embed: embedRet, callbacks: callbackRet };
  }

  /** 
   * updates the document from pre-prepared mutation
   * @param {Mutation} mutation
   */
  static async _updateDocument(mutation) {

    const doc = mutation.document;
    const {update, options} = mutation.getUpdate();
    
    const flagStackUpdate = mutation._updateMutationStack();

    if(!flagStackUpdate) return false;

    /* merge in our current stack with the update data */
    mergeObject(update, flagStackUpdate)

    logger.debug('Performing update:',doc, update);
    
    await MODULE.wait(MODULE.setting('updateDelay')); // @workaround for semaphore bug

    /** perform the updates */
    if (!isObjectEmpty(update)) {

      /* wait until the last possible second to insert the mutation stack data */
      await doc?.update(update, options);
    }

    return;
  }

  /**
   * Updates the document's embedded collection from a pre-prepared mutation
   * embeddedUpdates keyed by embedded name, contains shorthand
   * @param {Mutation} mutation
   */
  static async _updateEmbedded(mutation){

    const doc = mutation.document;
    const embeddedUpdates = mutation.getEmbedded();

    for(const embedded of Object.values(embeddedUpdates)){
      await Mutator._performEmbeddedUpdates(
        doc, 
        embedded.collectionName, 
        embedded.shorthand,
        embedded.comparisonKey
      );
    }

  }

  /**
   * @param {ClientDocument} document
   * @param {object} [options]
   * @param {string} [options.name]
   * @param {string} [options.id]
   */
  static async revert(document, {name, id} = {}) {
    const stack = new MutationStack(document);

    /** @type StackData */
    let entry = id ? stack.get(id) : name ? stack.getName(name) : stack.pop();

    if(!entry) {
      return DocMutator.error();
    }

    /* need to have permissions to this stack entry in order to do anything */
    if(!entry.isOwner) {
      return DocMutator.error();
    }

    if(!document.isOwner) {
      return DocMutator.requestRevert(document, {mutation: entry.id})
    }

    /** 
     * construct Mutation derived class from class field
     * @type Mutation
     */
    const revivedMut = globalThis.warpgate.mutators[entry.cls].fromStack(stack, entry.id);
    
    //run pre-revert callbacks
    const preRet = await Promise.all(
      revivedMut.callAll(Mutation.STAGE.PRE_REVERT, entry.id)
    );

    /* can be cancelled, if so, bail */
    if (preRet.some((ret) => ret === false)) return false;

    /* Add stack (flags.warpgate.mutate) to the update */
    revivedMut.add(stack.toObject(true)); 

    //apply the changes
    let result = await DocMutator.apply(revivedMut);

    /* we may have been cancelled internally before the "mutation" was applied */
    if (!result) return false;

    //no cancel from the mutator, moving on and storing pre revert rv
    result.callbacks[Mutation.STAGE.PRE_REVERT] = preRet;
    
    //run through the links array and call revert (ourself) from on each muid in that list
    const linkedReverts = entry.links.map( muid => {
      return {
        document: fromUuid(muid.uuid),
        id: muid.mutation,
      }
    });

    linkedReverts.map( async ({document, id}) => DocMutator.revert(await document, {id}) );

    result.links = await Promise.all(linkedReverts);

    //Post revert callback
    /* post revert callback (no cancel to be had) */
    result.callbacks[Mutation.STAGE.POST_REVERT] = await Promise.all(
      revivedMut.callAll(Mutation.STAGE.POST_REVERT)
    );

    return result;
  }

  static async _popMutation(doc, mutationName) {

    let mutateStack = doc?.getFlag(MODULE.data.name, 'mutate');

    if (!mutateStack || !doc){
      logger.debug(`Could not pop mutation named ${mutationName} from actor ${doc?.name}`);
      return undefined;
    }

    let mutateData = undefined;

    if (!!mutationName) {
      /* find specific mutation */
      const index = mutateStack.findIndex( mutation => mutation.name === mutationName );

      /* check for no result and error */
      if ( index < 0 ) {
        logger.error(`Could not locate mutation named ${mutationName} in actor ${doc.name}`);
        return undefined;
      }

      /* otherwise, retrieve and remove */
      mutateData = mutateStack.splice(index, 1)[0];

      for( let i = index; i < mutateStack.length; i++){

        /* get the values stored in our delta and push any overlapping ones to
         * the mutation next in the stack
         */
        const stackUpdate = filterObject(mutateData.delta, mutateStack[i].delta);
        mergeObject(mutateStack[i].delta, stackUpdate);

        /* remove any changes that exist higher in the stack, we have
         * been overriden and should not restore these values
         */
        mutateData.delta = MODULE.unique(mutateData.delta, mutateStack[i].delta)
      }

    } else {
      /* pop the most recent mutation */
      mutateData = mutateStack?.pop();
    }

    /* if there are no mutations left on the stack, remove our flag data
     * otherwise, store the remaining mutations */
    if (mutateStack.length == 0) {
      await doc.unsetFlag(MODULE.data.name, 'mutate');
    } else {
      await doc.setFlag(MODULE.data.name, 'mutate', mutateStack);
    }
    logger.debug(MODULE.localize('debug.finalRevertUpdate'), mutateData);
    return mutateData;
  }
}
