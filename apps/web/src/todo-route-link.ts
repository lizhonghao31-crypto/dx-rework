import type {TodoRouteDescriptor} from "@dx-rework/contracts";
import {todoDestination} from "@dx-rework/contracts/todo-destination";
import {createWebUrls} from "../url-contract.js";
const {pageUrl}=createWebUrls(import.meta.env.BASE_URL);
export const todoRouteHref=(route:TodoRouteDescriptor):string=>pageUrl(todoDestination(route));
